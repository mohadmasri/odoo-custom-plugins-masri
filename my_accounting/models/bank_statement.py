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


def _plain_digits(text):
    """يوحّد الأرقام العربية باللاتينية ليُقارن ما كُتب بهذه وتلك."""
    return (text or '').translate(ARABIC_DIGITS)


def _number(text):
    return float((text or '0').replace(',', ''))


def _to_date(text):
    day, month, year = DATE_RE.match(text).groups()
    return fields.Date.to_date('%s-%s-%s' % (year, month, day))


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
        self.line_ids.write({'move_line_id': False, 'match_reason': False,
                             'match_strong': False})
        Line = self.env['myaccounting.move.line']
        window = timedelta(days=10)
        candidates = Line.search([
            ('account_id', '=', self.account_id.id),
            ('move_id.state', '=', 'posted'),
            ('move_id.date', '>=', (self.date_from or self.date_to) - window),
            ('move_id.date', '<=', (self.date_to or self.date_from) + window),
        ])
        taken = set()
        for statement_line in self.line_ids.sorted(lambda item: item.sequence):
            best = None
            best_score = -1
            best_reason, best_strong = '', False
            for candidate in candidates:
                if candidate.id in taken:
                    continue
                book = round((candidate.debit or 0.0) - (candidate.credit or 0.0), 3)
                if abs(book - statement_line.amount) > 0.005:
                    continue
                days = abs((candidate.move_id.date - statement_line.date).days)
                if days > 10:
                    continue
                score = 100 - days
                text = _plain_digits(candidate.name or '')
                reason, strong = 'المبلغ والتاريخ فقط', False
                if statement_line.cheque and statement_line.cheque in text:
                    score += 100
                    reason, strong = 'رقم الشيك %s في القيد' % statement_line.cheque, True
                elif statement_line.reference and statement_line.reference in (
                        candidate.name or ''):
                    score += 60
                    reason, strong = 'مرجع البنك في القيد', True
                elif days == 0:
                    reason = 'المبلغ ونفس اليوم'
                if score > best_score:
                    best, best_score = candidate, score
                    best_reason, best_strong = reason, strong
            if best is not None:
                taken.add(best.id)
                statement_line.write({
                    'move_line_id': best.id,
                    'match_reason': best_reason,
                    'match_strong': best_strong,
                })
        return True

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
            'matched_count': len(matched),
            'strong_count': len(matched.filtered('match_strong')),
            'matched': [line._payload() for line in matched.sorted(lambda l: l.sequence)],
            'unmatched': [line._payload() for line in unmatched.sorted(lambda l: l.sequence)],
            'unmatched_total': round(sum(unmatched.mapped('amount')), 3),
            'book_only': [{
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
        }

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

    def _payload(self):
        self.ensure_one()
        move = self.move_line_id.move_id
        return {
            'id': self.id,
            'date': fields.Date.to_string(self.date),
            'label': self.label or '',
            'reference': self.reference or '',
            'cheque': self.cheque or '',
            'amount': self.amount,
            'balance': self.balance,
            'matched': bool(self.move_line_id),
            'reason': self.match_reason or '',
            'strong': self.match_strong,
            'move_id': move.id or False,
            'move': move.name or '',
            'move_label': self.move_line_id.name or '',
        }
