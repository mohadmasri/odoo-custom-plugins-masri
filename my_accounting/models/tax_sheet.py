"""جداول الإقرار الضريبي: كشف المشتريات وكشف المبيعات ومرتجعاتهما.

تُبنى من حركات حساب ضريبة المبيعات في الفترة (عدا تسديد الإقرارات)، ثم
تبقى جداول قابلة للتعديل: تُحرَّر خاناتها وتُضاف إليها صفوف وتُحذف، لأن
الإقرار يحتاج بيانات ليست في القيود (الرقم الضريبي مثلاً).

كل مرتجع يُسجَّل في جدول مستقل، وتُوضع إشارة على سطره الأصلي تدلّ عليه.
"""
import re

from odoo import api, fields, models
from odoo.exceptions import UserError

TABLES = [
    ('purchase', 'المشتريات (من)'),
    ('purchase_return', 'مرتجعات المشتريات'),
    ('sale', 'المبيعات'),
    ('sale_return', 'مرتجعات المبيعات'),
]

# بند الضريبة الذي يذكر "إقرار" هو تسديد إقرار سابق، لا يدخل الكشف
SETTLEMENT_RE = re.compile(r'[اأإ]قرار')
ANY_NUMBER_RE = re.compile(r'([0-9٠-٩]+)')
# "مرتجع عن فاتورة رقم 290": رقم الفاتورة الأصلية
RETURN_RE = re.compile(r'مرتجع\s*عن[^0-9٠-٩]*([0-9٠-٩]+)')
RETURN_WORD_RE = re.compile(r'مرتجع')

ARABIC_DIGITS = str.maketrans('٠١٢٣٤٥٦٧٨٩', '0123456789')

# خانة الصف التي يقابلها كل عمود من أعمدة الجدول
FIELD_OF_COLUMN = {
    'taxno': 'tax_number',
    'doc': 'doc_number',
    'type': 'doc_type',
    'date': 'date',
    'label': 'label',
    'party': 'party',
    'amount': 'amount',
    'tax': 'tax',
    'move': 'move_name',
}

CHUNK_RE = re.compile(r'(\d+)')


def _natural_key(text):
    """مفتاح ترتيب يقرأ الأرقام أرقاماً: "4/8" قبل "12/8"، و"297" قبل "5325"."""
    parts = []
    for piece in CHUNK_RE.split(_clean_number(text)):
        if piece.isdigit():
            parts.append((0, int(piece), ''))
        elif piece:
            parts.append((1, 0, piece))
    return tuple(parts)


def _row_key(item, column):
    field = FIELD_OF_COLUMN.get(column, column)
    value = item.get(field)
    if column in ('amount', 'tax'):
        return (0, float(value or 0.0), ())
    # الخانات الفارغة في الآخر مهما كان الاتجاه ليس مطلوباً هنا؛
    # تكفي قيمة أولى تضعها بعد المملوءة في التصاعدي
    return (1 if not value else 0, 0.0, _natural_key(value))


def _clean_number(text):
    return (text or '').translate(ARABIC_DIGITS).strip()


def doc_number_of(label):
    """رقم المستند من بيانه.

    البيان يذكر أرقاماً أخرى (شهر، سنة، رقم مطالبة)، ورقم الفاتورة هو
    آخرها عادةً: "مطالبة فرع جبل عمان رقم 2 شهر 2026/7 ف رقم 286" ← 286.
    وفي المرتجع نقطع عند كلمة "مرتجع" لنأخذ رقمه هو لا رقم أصله.
    """
    text = (label or '')
    head = text.split('مرتجع')[0].strip() or text
    numbers = ANY_NUMBER_RE.findall(head)
    return _clean_number(numbers[-1]) if numbers else ''


class MyAccountingTaxSheet(models.Model):
    _name = 'myaccounting.tax.sheet'
    _description = 'كشف الإقرار الضريبي'
    _order = 'year_from desc, month_from desc'

    year_from = fields.Integer(string='سنة البداية', required=True)
    month_from = fields.Integer(string='شهر البداية', required=True)
    year_to = fields.Integer(string='سنة النهاية', required=True)
    month_to = fields.Integer(string='شهر النهاية', required=True)
    row_ids = fields.One2many('myaccounting.tax.sheet.row', 'sheet_id', string='الصفوف')

    @api.model
    def _find(self, year_from, month_from, year_to, month_to, create=False):
        domain = [('year_from', '=', int(year_from)), ('month_from', '=', int(month_from)),
                  ('year_to', '=', int(year_to)), ('month_to', '=', int(month_to))]
        sheet = self.search(domain, limit=1)
        if not sheet and create:
            sheet = self.create({
                'year_from': int(year_from), 'month_from': int(month_from),
                'year_to': int(year_to), 'month_to': int(month_to),
            })
        return sheet

    # ------------------------------------------------------------------
    # القراءة
    # ------------------------------------------------------------------

    @api.model
    def get_sheet(self, year_from, month_from, year_to, month_to):
        sheet = self._find(year_from, month_from, year_to, month_to, create=True)
        return sheet._payload()

    def _payload(self):
        self.ensure_one()
        rows = {key: [] for key, _label in TABLES}
        for row in self.row_ids:
            rows[row.table].append(row._payload())
        # ترتيب الصفوف حسب عمود الجدول، إعداداً يسري على كل الإقرارات
        sorts = self.env['myaccounting.tax.sort'].get_sorts()
        for key, _label in TABLES:
            order = sorts.get(key) or {}
            if order.get('key'):
                rows[key].sort(key=lambda item: _row_key(item, order['key']),
                               reverse=order.get('descending', False))
        totals = {}
        for key, _label in TABLES:
            totals[key] = {
                'amount': sum(item['amount'] for item in rows[key]),
                'tax': sum(item['tax'] for item in rows[key]),
            }
        return {
            'id': self.id,
            'tables': [{'key': key, 'label': label} for key, label in TABLES],
            'rows': rows,
            'totals': totals,
            'empty': not self.row_ids,
        }

    # ------------------------------------------------------------------
    # البناء من القيود
    # ------------------------------------------------------------------

    @api.model
    def _tax_groups(self, year_from, month_from, year_to, month_to):
        """كل حركة على حساب الضريبة في الفترة، مع أساسها ونوعها."""
        TaxReturn = self.env['myaccounting.tax.return']
        settings = TaxReturn._settings()
        tax_account = settings['tax_account']
        income_account = settings['income_account']
        if not tax_account:
            raise UserError('لم يُحدَّد حساب ضريبة المبيعات في إعدادات الكتل الجاهزة.')
        rate = settings['rate'] or 0.0
        moves = TaxReturn._period_moves(year_from, month_from, year_to, month_to)
        groups = []
        for move in moves.filtered(lambda mv: mv.state == 'posted'):
            buckets = {}
            for line in move.line_ids:
                buckets.setdefault((line.name or '').strip(), []).append(line)
            # إيرادات القيد مرتبة برقم مستندها، لأن بند الضريبة قد يحمل بياناً
            # مختلفاً قليلاً عن بند الإيراد (فاتورة معفاة مثلاً)
            income_by_number = {}
            # الطرف المقابل (لصالح من): حساب الجهة في الفاتورة الصادرة،
            # وحساب المورّد في الواردة. نفهرسه بالجانب ورقم المستند أيضاً
            # لأن بيان بند الضريبة قد يختلف عن بيان بند الطرف.
            party_by_number = {}
            party_by_label = []
            for line in move.line_ids:
                if line.account_id == income_account:
                    number = doc_number_of(line.name)
                    if number:
                        income_by_number.setdefault(number, 0.0)
                        income_by_number[number] += line.credit - line.debit
                elif line.account_id and line.account_id != tax_account:
                    side = 'debit' if line.debit else ('credit' if line.credit else '')
                    if not side:
                        continue
                    text = (line.name or '').strip()
                    # بند المرتجع وبند الفاتورة يحملان الرقم نفسه، فنميّزهما
                    back = bool(RETURN_WORD_RE.search(text))
                    number = doc_number_of(text)
                    if number:
                        party_by_number.setdefault((back, side, number),
                                                   line.account_id.name)
                    if len(text) >= 4:
                        party_by_label.append((back, side, text, line.account_id.name))
            for label, lines in buckets.items():
                tax_lines = [line for line in lines if line.account_id == tax_account]
                if not tax_lines:
                    continue
                if SETTLEMENT_RE.search(label) or SETTLEMENT_RE.search(move.ref or ''):
                    continue
                tax = sum(line.credit - line.debit for line in tax_lines)
                income = sum(line.credit - line.debit
                             for line in lines if line.account_id == income_account)
                other_debit = sum(line.debit for line in lines
                                  if line.account_id not in (tax_account | income_account))
                other_credit = sum(line.credit for line in lines
                                   if line.account_id not in (tax_account | income_account))
                if not income:
                    # لا إيراد ببيان البند نفسه: نبحث عنه برقم المستند
                    income = income_by_number.get(doc_number_of(label), 0.0)
                if income > 0:
                    table, amount, tax_value = 'sale', income, tax
                elif income < 0:
                    table, amount, tax_value = 'sale_return', -income, -tax
                elif tax < 0 or (not tax and other_debit):
                    table, amount, tax_value = 'purchase', other_debit, -tax
                else:
                    table, amount, tax_value = 'purchase_return', other_credit, tax
                # شراء بلا ضريبة مبيعات لا يُسجَّل في الإقرار ولا يُحتسب.
                # (أما المبيعات فتُسجَّل ولو كانت ضريبتها صفراً أو معفاة.)
                if table.startswith('purchase') and not tax_value:
                    continue
                # القيمة غائبة حين يختلف بيان بند المصروف عن بند الضريبة،
                # فنستنتجها من الضريبة ونسبتها ليراجعها المستخدم
                if not amount and tax_value and rate:
                    amount = round(abs(tax_value) / (rate / 100.0), 3)
                # الطرف يقابل الإيراد/المصروف: في البيع مدين، وفي الشراء دائن
                side = {'sale': 'debit', 'sale_return': 'credit',
                        'purchase': 'credit', 'purchase_return': 'debit'}[table]
                party = ''
                for line in lines:
                    if line.account_id in (tax_account | income_account) or not line.account_id:
                        continue
                    if (line.debit if side == 'debit' else line.credit):
                        party = line.account_id.name
                        break
                back = bool(RETURN_WORD_RE.search(label))
                if not party:
                    party = party_by_number.get((back, side, doc_number_of(label)), '')
                if not party:
                    # بيان بند الطرف قد يكون جزءاً من بيان بند الضريبة
                    # ("فحص تربة فلادلفيا" داخل "فحص تربة فلادلفيا / المجموعة…")
                    best = ''
                    for line_back, line_side, text, name in party_by_label:
                        if line_back != back or line_side != side:
                            continue
                        if (text in label or label in text) and len(text) > len(best):
                            best, party = text, name
                groups.append({
                    'table': table, 'label': label, 'move': move, 'party': party,
                    'line': tax_lines[0], 'amount': amount, 'tax': tax_value,
                })
        return groups

    def _row_values(self, group):
        label = group['label']
        move = group['move']
        return {
            'sheet_id': self.id,
            'table': group['table'],
            'doc_number': doc_number_of(label),
            'doc_type': 'قبض' if move.move_type == 'receipt' else 'قيد',
            'date': move.date,
            'label': label,
            'party': group.get('party') or '',
            'amount': group['amount'],
            'tax': group['tax'],
            'move_name': move.name or '',
            'move_id': move.id,
            'source_line_id': group['line'].id,
        }

    def _link_returns(self):
        """يربط كل مرتجع بسطره الأصلي ليظهر عليه رقم صغير يدلّ عليه."""
        self.ensure_one()
        originals = {}
        for row in self.row_ids.filtered(lambda r: r.table in ('purchase', 'sale')):
            if row.doc_number:
                originals.setdefault(row.doc_number, row)
        for row in self.row_ids.filtered(lambda r: r.table.endswith('_return')):
            match = RETURN_RE.search(row.label or '')
            if not match:
                continue
            original = originals.get(_clean_number(match.group(1)))
            if original:
                row.return_of_id = original.id

    @api.model
    def build_sheet(self, year_from, month_from, year_to, month_to, keep_edits=True):
        """يبني الكشف من القيود. keep_edits يضيف الجديد فقط ولا يمسّ ما حُرّر."""
        sheet = self._find(year_from, month_from, year_to, month_to, create=True)
        groups = self._tax_groups(year_from, month_from, year_to, month_to)
        if not keep_edits:
            sheet.row_ids.unlink()
            seen = set()
        else:
            seen = set(sheet.row_ids.mapped('source_line_id').ids)
        Row = self.env['myaccounting.tax.sheet.row']
        order = {key: index for index, (key, _label) in enumerate(TABLES)}
        new_rows = [group for group in groups if group['line'].id not in seen]
        new_rows.sort(key=lambda g: (order[g['table']], g['move'].sort_key or ''))
        base = max(sheet.row_ids.mapped('sequence') or [0])
        for index, group in enumerate(new_rows, start=1):
            Row.create(dict(sheet._row_values(group), sequence=base + index * 10))
        sheet._link_returns()
        return dict(sheet._payload(), added=len(new_rows))

    # ------------------------------------------------------------------
    # التحرير
    # ------------------------------------------------------------------

    @api.model
    def add_row(self, sheet_id, table):
        sheet = self.browse(int(sheet_id))
        last = max(sheet.row_ids.filtered(lambda r: r.table == table).mapped('sequence') or [0])
        self.env['myaccounting.tax.sheet.row'].create({
            'sheet_id': sheet.id, 'table': table, 'sequence': last + 10,
        })
        return sheet._payload()

    @api.model
    def save_row(self, row_id, values):
        row = self.env['myaccounting.tax.sheet.row'].browse(int(row_id))
        allowed = ('tax_number', 'doc_number', 'doc_type', 'date', 'label',
                   'party', 'amount', 'tax', 'move_name')
        clean = {}
        for key in allowed:
            if key not in values:
                continue
            if key in ('amount', 'tax'):
                clean[key] = float(values[key] or 0.0)
            elif key == 'date':
                clean[key] = values[key] or False
            else:
                clean[key] = (values[key] or '').strip()
        row.write(clean)
        row.sheet_id._link_returns()
        return row.sheet_id._payload()

    @api.model
    def delete_row(self, row_id):
        row = self.env['myaccounting.tax.sheet.row'].browse(int(row_id))
        sheet = row.sheet_id
        row.unlink()
        sheet._link_returns()
        return sheet._payload()


class MyAccountingTaxSheetRow(models.Model):
    _name = 'myaccounting.tax.sheet.row'
    _description = 'سطر في كشف الإقرار الضريبي'
    _order = 'sequence, id'

    sheet_id = fields.Many2one('myaccounting.tax.sheet', string='الكشف',
                               required=True, ondelete='cascade', index=True)
    sequence = fields.Integer(string='الترتيب', default=10)
    table = fields.Selection(TABLES, string='الجدول', required=True, default='purchase')

    tax_number = fields.Char(string='الرقم الضريبي')
    doc_number = fields.Char(string='رقم المستند')
    doc_type = fields.Char(string='نوعه')
    date = fields.Date(string='التاريخ')
    label = fields.Char(string='البيان')
    party = fields.Char(string='لصالح من')
    amount = fields.Float(string='القيمة', digits=(16, 3))
    tax = fields.Float(string='الضريبة', digits=(16, 3))
    move_name = fields.Char(string='سند القيد')

    move_id = fields.Many2one('myaccounting.move', string='القيد', ondelete='set null')
    source_line_id = fields.Many2one('myaccounting.move.line', string='بند الضريبة',
                                     ondelete='set null', index=True)
    return_of_id = fields.Many2one('myaccounting.tax.sheet.row', string='مرتجع عن',
                                   ondelete='set null')
    return_ids = fields.One2many('myaccounting.tax.sheet.row', 'return_of_id',
                                 string='مرتجعاته')

    def _payload(self):
        self.ensure_one()
        return {
            'id': self.id,
            'table': self.table,
            'tax_number': self.tax_number or '',
            'doc_number': self.doc_number or '',
            'doc_type': self.doc_type or '',
            'date': self.date and fields.Date.to_string(self.date) or '',
            'label': self.label or '',
            'party': self.party or '',
            'amount': self.amount,
            'tax': self.tax,
            'move_name': self.move_name or '',
            'move_id': self.move_id.id or False,
            'manual': not self.source_line_id,
            # إشارة المرتجع: رقم صغير على السطر الأصلي، وعلى المرتجع رقم مستنده
            'marks': [row.doc_number or '؟' for row in self.return_ids],
            'return_of': self.return_of_id.doc_number or '',
        }
