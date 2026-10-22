# -*- coding: utf-8 -*-
"""كشف البنك: يُقرأ من ملف البنك ثم يُطابَق مع قيود حساب البنك.

كشف البنك الأهلي يصدر PDF فيه لكل حركة سطر تاريخ ووصف ومبلغ ورصيد جارٍ،
وسطر مرجع تحته. واستخراج النص يلصق أحياناً المرجعَ بالمبلغ
("LOGP2512007450.000")، فلا يُقرأ المبلغ من النص: يُؤخذ من فرق الرصيد
الجاري، وهو أيضاً ما يحدّد أدخل المال أم خرج. ثم يُتحقَّق من القراءة
بمجاميع الكشف ورصيده الختامي.
"""
import base64
import re
from datetime import timedelta

from odoo import api, fields, models
from odoo.exceptions import UserError

DATE_RE = re.compile(r'^(\d{2})/(\d{2})/(\d{4})\b')
NUMBER_RE = re.compile(r'-?[\d,]+\.\d+')
REFERENCE_RE = re.compile(r'^(?:FT|MD|PD|TT|CRLC)[A-Z0-9.;]+$')
CHEQUE_RE = re.compile(r'CHQ\.?\s*NO[-\s]*(\d+)', re.IGNORECASE)
CHEQUE_ALT_RE = re.compile(r'Cheque No\s*(\d+)', re.IGNORECASE)
HEADER_IN_RE = re.compile(r'Total money in\s+([\d,]+\.\d+)')
HEADER_OUT_RE = re.compile(r'Total money out\s+([\d,]+\.\d+)')
ACCOUNT_RE = re.compile(r'Account Number\s+(\d+)')
IBAN_RE = re.compile(r'\b([A-Z]{2}\d{2}[A-Z0-9]{10,30})\b')
PERIOD_RE = re.compile(r'(\d{2}/\d{2}/\d{4})\s*-\s*(\d{2}/\d{2}/\d{4})')


ARABIC_DIGITS = str.maketrans('٠١٢٣٤٥٦٧٨٩', '0123456789')


CHEQUE_IN_TEXT = re.compile(r'(?:شيك|شيكات|chq|cheque)[^\d]{0,12}(\d{4,})', re.IGNORECASE)
MANY_CHEQUES = re.compile(r'شيكات|شكيات|من\s*\d{4,}\s*(?:الى|إلى)\s*\d{4,}|\bto\b\s*\d{4,}')


RANGE_RE = re.compile(r'(\d{4,6})\s*(?:الى|إلى|to|-)\s*(\d{4,6})', re.IGNORECASE)
ANY_CHEQUE_RE = re.compile(r'\b(\d{4,6})\b')


def _mentioned_numbers(text):
    """كل رقم شيك يذكره بند القيد، مع فكّ المدى ("من 205970 الى 205973")."""
    plain = _plain_digits(text or '')
    numbers = set(ANY_CHEQUE_RE.findall(plain))
    for first, last in RANGE_RE.findall(plain):
        start, end = int(first), int(last)
        if 0 < end - start <= 40:
            numbers.update(str(value) for value in range(start, end + 1))
    return numbers


def _mentions_guarantee(text, number, year):
    """هل يذكر البند كفالةً بهذا الرقم؟ تُكتب "111/26" وتُكتب "26/111"."""
    plain = _plain_digits(text or '')
    patterns = (
        r'(?<!\d)0*%d\s*/\s*%s(?!\d)' % (number, year),
        r'(?<!\d)%s\s*/\s*0*%d(?!\d)' % (year, number),
    )
    return any(re.search(pattern, plain) for pattern in patterns)


def _cheque_numbers(text):
    """أرقام الشيكات المذكورة في نصّ القيد، بعد توحيد الأرقام العربية."""
    plain = _plain_digits(text or '')
    return set(CHEQUE_IN_TEXT.findall(plain))


def _is_lump(text):
    """سطر يجمع عدّة شيكات ("شيكات"، "من 205970 الى 205975") لا يُطابَق واحداً بواحد."""
    plain = _plain_digits(text or '')
    if MANY_CHEQUES.search(plain):
        return True
    return len(set(re.findall(r'\b\d{5,6}\b', plain))) > 1


def _plain_digits(text):
    """يوحّد الأرقام العربية باللاتينية ليُقارن ما كُتب بهذه وتلك."""
    return (text or '').translate(ARABIC_DIGITS)


def _number(text):
    return float((text or '0').replace(',', ''))


def _to_date(text):
    day, month, year = DATE_RE.match(text).groups()
    return fields.Date.to_date('%s-%s-%s' % (year, month, day))


LG_RE = re.compile(r'LOG([PT])(\d{2})\d{2}(\d{4})', re.IGNORECASE)
LOAN_RE = re.compile(r'To Loan[:\s]*(\d+)', re.IGNORECASE)
CHQ_RE = re.compile(r'CHQ\.?\s*NO[-\s]*(\d+)', re.IGNORECASE)
BOOK_RE = re.compile(r'Cheque No\s*(\d+)\s*to\s*(\d+)', re.IGNORECASE)


def _guarantee(raw):
    found = LG_RE.search(raw or '')
    return ' رقم %d/%s' % (int(found.group(3)), found.group(2)) if found else ''


def _party(raw, after):
    """اسم الطرف بعد عبارة معيّنة في نصّ البنك."""
    lowered = (raw or '').lower()
    position = lowered.find(after.lower())
    if position == -1:
        return ''
    tail = (raw or '')[position + len(after):].strip(' -:')
    tail = re.sub(r'\b(?:FT|MD|PD|TT|BDC|CRLC)[A-Z0-9.;]*\d[A-Z0-9.;]*', '', tail)
    tail = NUMBER_RE.sub('', tail)
    tail = re.sub(r'^\s*(?:To\s+Acc|From\s+Acc)\s*[-:]?\s*', '', tail,
                  flags=re.IGNORECASE)
    words = ' '.join(tail.split())
    # الكشف يكرّر اسم المودِع مرّتين، فنكتفي بواحدة
    half = len(words) // 2
    if words[:half].strip() and words[:half].strip() == words[half:].strip():
        words = words[:half].strip()
    return words.strip(' -:')[:60]


KINDS = [
    ('cheque_out', 'شيكات صادرة منكم'),
    ('cheque_in', 'شيكات أودعتموها'),
    ('guarantee', 'كفالات'),
    ('transfer', 'حوالات وإيداعات'),
    ('loan', 'قروض وفوائد'),
    ('fees', 'مصاريف بنكية'),
    ('other', 'أخرى'),
]


def read_line(raw, amount):
    """نوع الحركة وشرحها بالعربية، كما نفهمهما من نصّ البنك."""
    text = raw or ''
    lowered = text.lower()
    if 'cash margin' in lowered and 'refund' not in lowered:
        return 'guarantee', 'تأمين كفالة%s' % _guarantee(text)
    if 'refund of cash margin' in lowered:
        return 'guarantee', 'مرتجع تأمين كفالة%s' % _guarantee(text)
    if 'guarantee issuance' in lowered:
        return 'guarantee', 'عمولة إصدار كفالة%s' % _guarantee(text)
    if 'repayment of commissions' in lowered:
        return 'guarantee', 'استرداد عمولة كفالة%s' % _guarantee(text)
    if 'stamps charges' in lowered:
        return 'guarantee', 'رسوم طوابع كفالة%s' % _guarantee(text)
    if 'loan granting facilities' in lowered:
        return 'loan', 'عمولة منح تسهيلات'
    if 'repayment of loan dues' in lowered:
        found = LOAN_RE.search(text)
        return 'loan', 'قسط قرض%s' % (' رقم %s' % found.group(1) if found else '')
    if 'interest payment' in lowered:
        return 'loan', 'فائدة'
    if 'cheque book issuance' in lowered:
        found = BOOK_RE.search(text)
        return 'fees', 'رسوم دفتر شيكات%s' % (
            ' (من %s إلى %s)' % (found.group(1), found.group(2)) if found else '')
    if 'courier charges' in lowered:
        return 'fees', 'رسوم بريد'
    found = CHQ_RE.search(text)
    if 'outward cheque' in lowered or 'cheque deposit' in lowered:
        return 'cheque_in', ('شيك وارد أودعتموه رقم %s' % found.group(1)
                             if found else 'شيك وارد أودعتموه')
    if 'cheque payment onus' in lowered:
        return 'cheque_out', ('شيك رقم %s صُرف داخل البنك' % found.group(1)
                              if found else 'شيك صُرف')
    if 'inward cheque' in lowered:
        return 'cheque_out', ('شيك رقم %s صادر منكم وصُرف' % found.group(1)
                              if found else 'شيك صادر منكم')
    if 'salaries transfers' in lowered:
        return 'fees', 'عمولة حوالة رواتب'
    if 'cash deposit' in lowered:
        party = _party(text, 'into your AC')
        return 'transfer', 'إيداع نقدي%s' % (' من %s' % party if party else '')
    if 'funds transfer to your ac' in lowered:
        party = _party(text, 'to your AC')
        return 'transfer', 'حوالة واردة%s' % (' من %s' % party if party else '')
    if 'funds transfer from your ac' in lowered:
        party = _party(text, 'from your AC')
        return 'transfer', 'حوالة صادرة%s' % (' إلى %s' % party if party else '')
    if 'funds transfer' in lowered:
        return 'transfer', 'حوالة %s' % ('واردة' if (amount or 0) > 0 else 'صادرة')
    if 'commission' in lowered or 'charges' in lowered:
        return 'fees', 'عمولة بنكية'
    return 'other', ''


class MyAccountingBankStatement(models.Model):
    _name = 'myaccounting.bank.statement'
    _description = 'كشف حساب بنكي'
    _order = 'date_to desc, id desc'

    name = fields.Char(string='الكشف', required=True)
    account_id = fields.Many2one('myaccounting.account', string='حساب البنك',
                                 required=True, ondelete='restrict')
    bank_account_number = fields.Char(string='رقم الحساب لدى البنك')
    iban = fields.Char(string='IBAN')
    date_from = fields.Date(string='من')
    date_to = fields.Date(string='إلى')
    opening_balance = fields.Float(string='الرصيد الافتتاحي', digits=(16, 3))
    closing_balance = fields.Float(string='الرصيد الختامي', digits=(16, 3))
    total_in = fields.Float(string='مجموع الوارد', digits=(16, 3))
    total_out = fields.Float(string='مجموع الصادر', digits=(16, 3))
    line_ids = fields.One2many('myaccounting.bank.statement.line', 'statement_id',
                               string='الحركات')

    # ------------------------------------------------------------------
    # القراءة من الملف
    # ------------------------------------------------------------------

    @api.model
    def _extract_text(self, data):
        try:
            from PyPDF2 import PdfReader
        except ImportError:
            raise UserError('مكتبة قراءة PDF غير مثبّتة على الخادم.')
        import io as _io
        reader = PdfReader(_io.BytesIO(data))
        return '\n'.join((page.extract_text() or '') for page in reader.pages)

    @api.model
    def _parse_text(self, text):
        """يحوّل نصّ الكشف إلى ترويسة وحركات."""
        lines = [line.strip() for line in text.splitlines() if line.strip()]
        header = {}
        found = ACCOUNT_RE.search(text)
        header['bank_account_number'] = found.group(1) if found else ''
        found = IBAN_RE.search(text)
        header['iban'] = found.group(1) if found else ''
        found = PERIOD_RE.search(text)
        if found:
            header['date_from'] = _to_date(found.group(1))
            header['date_to'] = _to_date(found.group(2))
        found = HEADER_IN_RE.search(text)
        header['total_in'] = _number(found.group(1)) if found else 0.0
        found = HEADER_OUT_RE.search(text)
        header['total_out'] = _number(found.group(1)) if found else 0.0

        # الحركات: كتلة تبدأ بتاريخ وتمتدّ حتى التاريخ التالي
        blocks = []
        current = None
        for line in lines:
            if line.startswith('Date ') or line.startswith('Balance on'):
                if line.startswith('Balance on'):
                    numbers = NUMBER_RE.findall(line)
                    if numbers:
                        header['closing_balance'] = _number(numbers[-1])
                current = None
                continue
            if DATE_RE.match(line):
                current = {'date': _to_date(line), 'text': [line]}
                blocks.append(current)
            elif current is not None:
                current['text'].append(line)

        opening = None
        movements = []
        previous = None
        for block in blocks:
            body = ' '.join(block['text'])
            # سطر المرجع يحمل رقم الحساب أحياناً ("CRLC.1000726059.0010107")
            # فيُقرأ رقماً هائلاً؛ الرصيد يُقرأ من سطور الوصف وحدها
            plain = [piece for piece in block['text'] if not REFERENCE_RE.match(piece)]
            numbers = NUMBER_RE.findall(' '.join(plain))
            if not numbers:
                continue
            balance = _number(numbers[-1])
            if 'Opening balance' in body:
                opening = balance
                previous = balance
                continue
            if previous is None:
                previous = balance
                continue
            if not movements and opening is not None and len(numbers) > 1:
                # الرصيد الافتتاحي مطبوع بمنزلتين لا ثلاث، فيُصحَّح من أول
                # حركة: مبلغها مكتوب قبل رصيدها، واتجاهه يُعرف بالمقارنة
                stated = _number(numbers[-2])
                for sign in (-1.0, 1.0):
                    if abs((balance - sign * stated) - opening) < 0.01:
                        opening = round(balance - sign * stated, 3)
                        previous = opening
                        break
            amount = round(balance - previous, 3)
            previous = balance
            reference = ''
            for piece in block['text'][1:]:
                if REFERENCE_RE.match(piece):
                    reference = piece
                    break
            cheque = ''
            found = CHEQUE_RE.search(body) or CHEQUE_ALT_RE.search(body)
            if found:
                cheque = found.group(1)
            label = block['text'][0][10:].strip()
            # يُنزع المبلغ والرصيد من آخر الوصف
            label = NUMBER_RE.sub('', label).strip(' -')
            extra = [piece for piece in block['text'][1:]
                     if piece != reference and not REFERENCE_RE.match(piece)]
            if extra:
                label = (label + ' ' + ' '.join(NUMBER_RE.sub('', piece) for piece in extra))
            movements.append({
                'raw': ' '.join(body.split())[:300],
                'date': block['date'],
                'label': ' '.join(label.split())[:250],
                'reference': reference,
                'cheque': cheque,
                'amount': amount,
                'balance': balance,
            })
        header['opening_balance'] = opening if opening is not None else 0.0
        header['closing_balance'] = header.get(
            'closing_balance', movements[-1]['balance'] if movements else 0.0)
        return header, movements

    @api.model
    def import_file(self, account_id, filename, content):
        """يقرأ ملفاً مرفوعاً (base64) ويحفظه كشفاً، ويُرجع المطابقة."""
        data = base64.b64decode(content)
        text = self._extract_text(data)
        header, movements = self._parse_text(text)
        if not movements:
            raise UserError('لم أجد حركات في هذا الملف. تأكّد أنه كشف حساب من البنك.')
        statement = self.create({
            'name': filename or 'كشف',
            'account_id': int(account_id),
            'bank_account_number': header.get('bank_account_number'),
            'iban': header.get('iban'),
            'date_from': header.get('date_from'),
            'date_to': header.get('date_to'),
            'opening_balance': header.get('opening_balance'),
            'closing_balance': header.get('closing_balance'),
            'total_in': header.get('total_in'),
            'total_out': header.get('total_out'),
            'line_ids': [(0, 0, dict(item, sequence=index * 10))
                         for index, item in enumerate(movements)],
        })
        statement.match()
        return statement.id

    # ------------------------------------------------------------------
    # التحقّق من القراءة
    # ------------------------------------------------------------------

    def _check(self):
        self.ensure_one()
        money_in = round(sum(line.amount for line in self.line_ids if line.amount > 0), 3)
        money_out = round(-sum(line.amount for line in self.line_ids if line.amount < 0), 3)
        expected = round(self.opening_balance + money_in - money_out, 3)
        return {
            'money_in': money_in,
            'money_out': money_out,
            'stated_in': round(self.total_in, 3),
            'stated_out': round(self.total_out, 3),
            'in_ok': abs(money_in - self.total_in) < 0.005,
            'out_ok': abs(money_out - self.total_out) < 0.005,
            'closing': round(self.closing_balance, 3),
            'computed': expected,
            'closing_ok': abs(expected - self.closing_balance) < 0.005,
        }

    # ------------------------------------------------------------------
    # المطابقة مع القيود
    # ------------------------------------------------------------------

    def match(self):
        """يربط كل حركة بنك بسطر قيد على حساب البنك، إن وُجد ما يطابقه."""
        self.ensure_one()
        # المؤكَّد بيد المستخدم لا تمسّه إعادة المطابقة
        loose = self.line_ids.filtered(lambda item: item.match_state != 'confirmed')
        loose.write({'move_line_id': False, 'match_reason': False,
                     'match_strong': False, 'match_state': False})
        Line = self.env['myaccounting.move.line']
        # الخطوة الأولى: رقم الشيك دليل قاطع، أينما ذُكر في القيد — على بند
        # البنك أو على بند المصروف — ومهما بَعُد تاريخ القيد، لأن القيود شهرية
        period_from = (self.date_from or self.date_to) - timedelta(days=120)
        period_to = (self.date_to or self.date_from) + timedelta(days=120)
        wide = Line.search([
            ('move_id.state', '=', 'posted'),
            ('move_id.date', '>=', period_from),
            ('move_id.date', '<=', period_to),
        ])
        by_number = {}
        for candidate in wide:
            for number in _mentioned_numbers(candidate.name):
                by_number.setdefault(number, []).append(candidate)
        used = set()
        for statement_line in loose.sorted(lambda item: item.sequence):
            if not statement_line.cheque:
                continue
            options = [item for item in by_number.get(statement_line.cheque, [])
                       if item.id not in used
                       and item.id not in statement_line.rejected_line_ids.ids]
            if not options:
                continue
            amount = abs(statement_line.amount)
            exact = [item for item in options
                     if abs(abs((item.debit or 0.0) - (item.credit or 0.0)) - amount) < 0.005]
            # بند حساب البنك أولى من بند المصروف، وإلا بقي بند البنك شاغراً
            # فالتقطه ترجيحٌ بالمبلغ لحركة أخرى
            chosen = sorted(exact or options,
                            key=lambda item: 0 if item.account_id == self.account_id else 1)[0]
            used.add(chosen.id)
            on_bank = chosen.account_id == self.account_id
            statement_line.write({
                'move_line_id': chosen.id,
                'match_reason': 'رقم الشيك %s مذكور في القيد%s'
                                % (statement_line.cheque,
                                   '' if on_bank else ' (على بند %s)' % chosen.account_id.name),
                'match_strong': True,
                'match_state': 'evidence',
            })
        loose = loose.filtered(lambda item: not item.move_line_id)

        # الخطوة الثانية: رقم الكفالة من مرجع البنك. وحركات الكفالة
        # الواحدة (تأمين + طوابع + عمولة) تُسجَّل عندك في بند واحد، فيجوز
        # أن تشير عدّة حركات إلى البند نفسه — بخلاف الشيكات.
        for statement_line in loose.sorted(lambda item: item.sequence):
            text = statement_line.raw or statement_line.label or ''
            found = LG_RE.search(text)
            if not found:
                continue
            year, number = found.group(2), int(found.group(3))
            lowered = text.lower()
            back = 'refund' in lowered or 'repayment of commissions' in lowered
            options = [item for item in wide
                       if _mentions_guarantee(item.name, number, year)
                       and item.id not in statement_line.rejected_line_ids.ids]
            if not options:
                continue

            def rank(item, back=back):
                name = item.name or ''
                return (0 if item.account_id == self.account_id else 1,
                        0 if ('مرتجع' in name) == back else 1,
                        item.id)

            chosen = sorted(options, key=rank)[0]
            statement_line.write({
                'move_line_id': chosen.id,
                'match_reason': 'رقم الكفالة %d/%s مذكور في القيد' % (number, year),
                'match_strong': True,
                'match_state': 'evidence',
            })
        loose = loose.filtered(lambda item: not item.move_line_id)

        # الترجيح بالمبلغ وحده لا يخرج من فترة الكشف، وإلا وصل إلى شهر آخر
        candidates = Line.search([
            ('account_id', '=', self.account_id.id),
            ('move_id.state', '=', 'posted'),
            ('move_id.date', '>=', self.date_from or self.date_to),
            ('move_id.date', '<=', self.date_to or self.date_from),
        ])
        taken = set(self.line_ids.filtered('move_line_id').mapped('move_line_id').ids)
        for statement_line in loose.sorted(lambda item: item.sequence):
            best = None
            best_score = -1
            best_reason, best_strong = '', False
            rejected = set(statement_line.rejected_line_ids.ids)
            ties = 0
            for candidate in candidates:
                if candidate.id in taken or candidate.id in rejected:
                    continue
                book = round((candidate.debit or 0.0) - (candidate.credit or 0.0), 3)
                if abs(book - statement_line.amount) > 0.005:
                    continue
                days = abs((candidate.move_id.date - statement_line.date).days)
                # القيود شهرية بتاريخ آخر الشهر، فالتاريخ يرجّح ولا يُقصي
                text = candidate.name or ''
                cheques = _cheque_numbers(text)
                # القيد يذكر شيكاً آخر: ليس هو قطعاً
                if statement_line.cheque and cheques and statement_line.cheque not in cheques:
                    continue
                strong = False
                if statement_line.cheque and statement_line.cheque in cheques:
                    score = 1000 - days
                    reason, strong = 'رقم الشيك %s في القيد' % statement_line.cheque, True
                elif statement_line.reference and statement_line.reference in text:
                    score = 900 - days
                    reason, strong = 'مرجع البنك في القيد', True
                elif _is_lump(text):
                    # سطر يجمع عدّة شيكات لا يُطابَق واحداً بواحد
                    continue
                else:
                    score = 100 - days
                    reason = 'المبلغ ونفس اليوم' if days == 0 else 'المبلغ والتاريخ فقط'
                if score > best_score:
                    best, best_score = candidate, score
                    best_reason, best_strong = reason, strong
                    ties = 1
                elif score == best_score:
                    ties += 1
            if best is None:
                continue
            if not best_strong and ties > 1:
                # مرشّحان متساويان بلا دليل: لا نختار، نتركه للمستخدم
                statement_line.write({
                    'match_reason': 'أكثر من قيد يطابق المبلغ — اختر بنفسك',
                    'match_state': False,
                })
                continue
            taken.add(best.id)
            statement_line.write({
                'move_line_id': best.id,
                'match_reason': best_reason,
                'match_strong': best_strong,
                'match_state': 'evidence' if best_strong else 'suggested',
            })
        return True

    @api.model
    def confirm_match(self, line_id):
        line = self.env['myaccounting.bank.statement.line'].browse(int(line_id))
        line.match_state = 'confirmed'
        return line.statement_id._payload()

    @api.model
    def reject_match(self, line_id):
        line = self.env['myaccounting.bank.statement.line'].browse(int(line_id))
        if line.move_line_id:
            line.rejected_line_ids = [(4, line.move_line_id.id)]
        line.write({'move_line_id': False, 'match_reason': False,
                    'match_strong': False, 'match_state': False})
        return line.statement_id._payload()

    # ------------------------------------------------------------------
    # العرض
    # ------------------------------------------------------------------

    def _payload(self):
        self.ensure_one()
        check = self._check()
        matched = self.line_ids.filtered('move_line_id')
        unmatched = self.line_ids - matched
        book_lines = self._book_lines()
        used = set(matched.mapped('move_line_id').ids)
        book_only = [line for line in book_lines if line.id not in used]
        return {
            'id': self.id,
            'name': self.name,
            'account': self.account_id.display_name or self.account_id.name,
            'account_id': self.account_id.id,
            'bank_account_number': self.bank_account_number or '',
            'iban': self.iban or '',
            'date_from': self.date_from and fields.Date.to_string(self.date_from) or '',
            'date_to': self.date_to and fields.Date.to_string(self.date_to) or '',
            'opening_balance': self.opening_balance,
            'closing_balance': self.closing_balance,
            'check': check,
            'lines': [line._payload() for line in self.line_ids.sorted(lambda l: l.sequence)],
            'kinds': self._kind_counts(),
            'matched_count': len(matched),
            'unmatched_count': len(unmatched),
            'unmatched_total': round(sum(unmatched.mapped('amount')), 3),
            'book_only_ignored': [{
                'id': line.id,
                'move_id': line.move_id.id,
                'move': line.move_id.name or '',
                'date': fields.Date.to_string(line.move_id.date),
                'label': line.name or '',
                'amount': round((line.debit or 0.0) - (line.credit or 0.0), 3),
            } for line in book_only],
            'book_only_total': round(sum((line.debit or 0.0) - (line.credit or 0.0)
                                         for line in book_only), 3),
            'book_balance': self._book_balance(),
            'groups': self._groups(),
        }

    def _rule_of(self, label):
        rules = self.env['myaccounting.bank.rule'].get_rules()
        from .bank_rule import normalize_key
        return rules.get(normalize_key(label), {}).get('name', '')

    def _groups(self):
        """الحركات غير المطابَقة مجموعةً بنصّها، لتُعرَّف مرة واحدة."""
        self.ensure_one()
        from .bank_rule import normalize_key
        rules = self.env['myaccounting.bank.rule'].get_rules()
        groups = {}
        for line in self.line_ids:
            if line.move_line_id:
                continue
            key = normalize_key(line.label)
            entry = groups.setdefault(key, {
                'key': key, 'count': 0, 'total': 0.0, 'samples': [],
                'rule': rules.get(key) or False,
            })
            entry['count'] += 1
            entry['total'] = round(entry['total'] + line.amount, 3)
            if len(entry['samples']) < 3:
                entry['samples'].append({
                    'date': fields.Date.to_string(line.date),
                    'label': line.label or '',
                    'amount': line.amount,
                })
        return sorted(groups.values(), key=lambda item: -item['count'])

    def _kind_counts(self):
        """عدد حركات كل نوع، وكم منها لم يظهر في القيود."""
        counts = {key: {'key': key, 'label': label, 'count': 0, 'missing': 0}
                  for key, label in KINDS}
        for line in self.line_ids:
            kind, _note = read_line(line.raw or line.label, line.amount)
            entry = counts[kind]
            entry['count'] += 1
            if not line.move_line_id:
                entry['missing'] += 1
        return [entry for entry in counts.values() if entry['count']]

    def _book_lines(self):
        self.ensure_one()
        if not self.date_from or not self.date_to:
            return self.env['myaccounting.move.line']
        return self.env['myaccounting.move.line'].search([
            ('account_id', '=', self.account_id.id),
            ('move_id.state', '=', 'posted'),
            ('move_id.date', '>=', self.date_from),
            ('move_id.date', '<=', self.date_to),
        ], order='id')

    def _book_balance(self):
        """رصيد الحساب في الدفاتر حتى نهاية الكشف، مع رصيده الافتتاحي."""
        self.ensure_one()
        lines = self.env['myaccounting.move.line'].search([
            ('account_id', '=', self.account_id.id),
            ('move_id.state', '=', 'posted'),
            ('move_id.date', '<=', self.date_to or fields.Date.context_today(self)),
        ])
        movement = sum((line.debit or 0.0) - (line.credit or 0.0) for line in lines)
        return round((self.account_id.opening_balance or 0.0) + movement, 3)

    @api.model
    def get_statement(self, statement_id=False):
        statement = self.browse(int(statement_id)) if statement_id else self.search([], limit=1)
        return statement._payload() if statement else False

    @api.model
    def get_statements(self):
        return [{
            'id': statement.id,
            'name': statement.name,
            'account': statement.account_id.name,
            'date_from': statement.date_from and fields.Date.to_string(statement.date_from) or '',
            'date_to': statement.date_to and fields.Date.to_string(statement.date_to) or '',
            'lines': len(statement.line_ids),
        } for statement in self.search([], limit=50)]

    @api.model
    def get_bank_accounts(self):
        """الحسابات التي تصلح أن تكون حساب بنك: الرئيسية منها."""
        accounts = self.env['myaccounting.account'].search(
            [('parent_id', '=', False)], order='code')
        last = self.search([], limit=1)
        return {
            'accounts': [{'id': account.id, 'code': account.code or '',
                          'name': account.name or ''} for account in accounts],
            'default_id': last.account_id.id if last else (accounts[:1].id or False),
        }

    @api.model
    def get_account_options(self):
        """كل الحسابات لمنتقي "الحساب المقابل" في تعريف الحركات."""
        accounts = self.env['myaccounting.account'].search([], order='code')
        seen = {}
        for account in accounts:
            seen[account.name] = seen.get(account.name, 0) + 1
        options = []
        for account in accounts:
            display = account.name or account.code or ''
            if seen.get(account.name, 0) > 1 and account.parent_id:
                display = '%s / %s' % (account.name, account.parent_id.name)
            options.append({'token': str(account.id), 'display': display,
                            'hint': account.code or ''})
        return options

    def delete_statement(self):
        self.unlink()
        return True


class MyAccountingBankStatementLine(models.Model):
    _name = 'myaccounting.bank.statement.line'
    _description = 'حركة في كشف البنك'
    _order = 'sequence, id'

    statement_id = fields.Many2one('myaccounting.bank.statement', required=True,
                                   ondelete='cascade')
    sequence = fields.Integer(string='الترتيب')
    raw = fields.Char(string='نصّ البنك كما هو')
    date = fields.Date(string='التاريخ')
    label = fields.Char(string='البيان')
    reference = fields.Char(string='مرجع البنك')
    cheque = fields.Char(string='رقم الشيك')
    amount = fields.Float(string='المبلغ', digits=(16, 3),
                          help='موجب: دخل المال. سالب: خرج.')
    balance = fields.Float(string='الرصيد الجاري', digits=(16, 3))
    move_line_id = fields.Many2one('myaccounting.move.line', string='سطر القيد المطابق',
                                   ondelete='set null')
    match_reason = fields.Char(string='سبب المطابقة')
    match_strong = fields.Boolean(string='مطابقة بدليل',
                                  help='رقم شيك أو مرجع بنك مذكور في القيد، لا مجرّد مبلغ.')
    match_state = fields.Selection(
        [('evidence', 'بدليل'), ('suggested', 'مقترح'), ('confirmed', 'مؤكَّد')],
        string='حال المطابقة')
    rejected_line_ids = fields.Many2many(
        'myaccounting.move.line', 'myaccounting_bank_line_rejected_rel',
        'statement_line_id', 'move_line_id', string='اقتراحات مرفوضة')

    def _payload(self):
        self.ensure_one()
        move = self.move_line_id.move_id
        kind, note = read_line(self.raw or self.label, self.amount)
        return {
            'id': self.id,
            'date': fields.Date.to_string(self.date),
            'label': self.label or '',
            'reference': self.reference or '',
            'cheque': self.cheque or '',
            'amount': self.amount,
            'balance': self.balance,
            'matched': bool(self.move_line_id),
            'guess': bool(self.move_line_id) and not self.match_strong,
            'reason': self.match_reason or '',
            'kind': kind,
            'note': note,
            'move_id': move.id or False,
            'move': move.name or '',
            'move_label': self.move_line_id.name or '',
        }
