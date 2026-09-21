import re

from odoo import api, fields, models
from odoo.exceptions import UserError

from .account_move import normalize_digits

# رقم الفاتورة في البيان: أول رقم بعد "فاتورة" أو "مطالبة" أو الاختصار "ف"
# (مع "رقم" أو "ر" أو علامة اختياريّة). مثال: "مطالبة رقم 276 / مطالبة رقم 2"
# يُؤخذ منها 276 لأنها الأولى.
INVOICE_NUMBER_RE = re.compile(
    r'(?:فاتور[ةه]|مطالب[ةه]|(?<![\w])ف)\s*[.:#-]?\s*(?:رقم|ر)?\s*[.:#-]?\s*(\d+)')
RETURN_RE = re.compile(r'مرتجع|ارجاع|إرجاع')


def extract_invoice_number(*labels):
    for label in labels:
        match = INVOICE_NUMBER_RE.search(normalize_digits(label or ''))
        if match:
            return int(match.group(1))
    return None


class MyAccountingCustomers(models.AbstractModel):
    _name = 'myaccounting.customers'
    _description = 'العملاء: الفواتير الصادرة وأرصدة الذمم'

    @api.model
    def _accounts_under_roots(self, keyword):
        """الحسابات الرئيسية التي يحوي اسمها الكلمة المحددة، وكل ما تحتها."""
        Account = self.env['myaccounting.account']
        roots = Account.search([('parent_id', '=', False)]).filtered(
            lambda account: keyword in (account.name or '').replace('إ', 'ا').replace('أ', 'ا'))
        return Account.search([('id', 'child_of', roots.ids)]) if roots else Account

    @api.model
    def _revenue_accounts(self):
        return self._accounts_under_roots('ايراد')

    @api.model
    def _receivable_accounts(self):
        """حسابات العملاء: كل ما تحت حساب "الذمم"."""
        return self._accounts_under_roots('ذمم')

    @api.model
    def get_customers_data(self, include_drafts=False):
        """العملاء وفواتيرهم وتحصيلاتهم.

        - العميل: كل حساب تحت "الذمم" عليه فاتورة في قيد إيرادات أو تحصيل في سند قبض.
        - الفاتورة: بند مدين على حساب العميل داخل قيد إيرادات، ورقمها من البيان.
        - المرتجع: بند دائن على حساب العميل داخل قيد إيرادات.
        - الرصيد المستحق = إجمالي مدين الحساب − إجمالي دائنه، من كل القيود.
        """
        states = ['posted', 'draft', 'incomplete'] if include_drafts else ['posted']
        Line = self.env['myaccounting.move.line']
        revenue_ids = set(self._revenue_accounts().ids)
        receivable_ids = set(self._receivable_accounts().ids)

        revenue_moves = self.env['myaccounting.move'].search([
            ('state', 'in', states), ('move_type', '=', 'entry'),
            ('line_ids.account_id', 'in', list(revenue_ids) or [0]),
        ])
        receipt_moves = self.env['myaccounting.move'].search([
            ('state', 'in', states), ('move_type', '=', 'receipt'),
        ])

        invoices, receipts = [], []
        customer_ids = set()

        for move in revenue_moves:
            lines = list(move.line_ids)
            for index, line in enumerate(lines):
                if line.account_id.id not in receivable_ids:
                    continue  # الفاتورة هي بند حساب العميل (تحت الذمم) فقط
                if line.debit and not line.credit:
                    kind = 'invoice'
                    amount = line.debit
                elif line.credit and RETURN_RE.search(line.name or ''):
                    kind = 'return'
                    amount = -line.credit
                else:
                    continue  # بنود الضريبة وغيرها
                # إن خلا بيان بند الذمم من رقم، نأخذه من بند الإيرادات التالي له
                # (نمط القيد: ذمم ← إيرادات ← ضريبة لكل فاتورة)
                next_revenue_label = next(
                    (other.name or '' for other in lines[index + 1:] if other.account_id.id in revenue_ids), '')
                customer_ids.add(line.account_id.id)
                invoices.append({
                    'line_id': line.id,
                    'move_id': move.id,
                    'move_name': move.name,
                    'date': move.date and move.date.isoformat(),
                    'customer_id': line.account_id.id,
                    'customer': line.account_id.name,
                    'number': extract_invoice_number(line.name, next_revenue_label),
                    'label': line.name or '',
                    'amount': amount,
                    'kind': kind,
                    'state': move.state,
                })

        for move in receipt_moves:
            for line in move.line_ids:
                if line.account_id.id in receivable_ids and line.credit:
                    customer_ids.add(line.account_id.id)
                    receipts.append({
                        'move_id': move.id,
                        'move_name': move.name,
                        'date': move.date and move.date.isoformat(),
                        'customer_id': line.account_id.id,
                        'customer': line.account_id.name,
                        'label': line.name or '',
                        'amount': line.credit,
                        'state': move.state,
                    })

        # الرصيد من كل القيود (بما فيها أي تسويات يدوية) = مدين − دائن
        balances = {}
        if customer_ids:
            groups = Line._read_group(
                [('account_id', 'in', list(customer_ids)), ('move_id.state', 'in', states)],
                ['account_id'], ['debit:sum', 'credit:sum'])
            balances = {account.id: (debit or 0.0) - (credit or 0.0) for account, debit, credit in groups}

        customers = []
        for account in self.env['myaccounting.account'].browse(list(customer_ids)):
            own_invoices = [item for item in invoices if item['customer_id'] == account.id]
            invoiced = sum(item['amount'] for item in own_invoices if item['kind'] == 'invoice')
            returned = -sum(item['amount'] for item in own_invoices if item['kind'] == 'return')
            collected = sum(item['amount'] for item in receipts if item['customer_id'] == account.id)
            balance = balances.get(account.id, 0.0)
            customers.append({
                'id': account.id,
                'code': account.code or '',
                'name': account.name or '',
                'invoice_count': len([item for item in own_invoices if item['kind'] == 'invoice']),
                'invoiced': invoiced,
                'returned': returned,
                'collected': collected,
                # حركات أخرى على الحساب خارج الفواتير والسندات (تسويات، أرصدة افتتاحية...)
                'other': balance - (invoiced - returned - collected),
                'balance': balance,
            })
        customers.sort(key=lambda item: (-round(item['balance'], 3), item['name']))

        invoices.sort(key=lambda item: (item['number'] is None, item['number'] or 0,
                                        item['kind'] == 'return', item['line_id']))
        receipts.sort(key=lambda item: (item['date'] or '', item['move_name']))

        totals = {
            'invoiced': sum(item['invoiced'] for item in customers),
            'returned': sum(item['returned'] for item in customers),
            'collected': sum(item['collected'] for item in customers),
            'balance': sum(item['balance'] for item in customers),
        }
        return {
            'customers': customers,
            'invoices': invoices,
            'receipts': receipts,
            'totals': totals,
            'notes': self._review_notes(invoices, receipts, customers),
        }

    # ------------------------------------------------------------------
    # ملاحظات المراجعة: تُحسب تلقائياً من البيانات، وتُحلّ يدوياً مع سبب الحل
    # ------------------------------------------------------------------

    MAX_GAP_NOTES = 50  # حد أعلى لملاحظات الأرقام الناقصة حتى لا تغرق القائمة

    @api.model
    def _sequence_gaps(self, numbers):
        numbers = sorted(set(numbers))
        gaps = []
        for previous, current in zip(numbers, numbers[1:]):
            gaps.extend(range(previous + 1, current))
            if len(gaps) >= self.MAX_GAP_NOTES:
                return gaps[:self.MAX_GAP_NOTES]
        return gaps

    @api.model
    def _review_notes(self, invoices, receipts, customers):
        """كل ملاحظة: key ثابت، tab (أين تظهر)، title، detail، وروابط اختيارية
        (customer_id / move_id) لتصفيتها حسب العميل أو فتح القيد."""
        notes = []

        def add(key, kind, tab, title, detail='', customer_id=False, move_id=False):
            notes.append({'key': key, 'kind': kind, 'tab': tab, 'title': title, 'detail': detail,
                          'customer_id': customer_id, 'move_id': move_id})

        real_invoices = [item for item in invoices if item['kind'] == 'invoice']
        numbered = [item for item in real_invoices if item['number']]

        # 1) أرقام ناقصة في تسلسل الفواتير
        for number in self._sequence_gaps([item['number'] for item in numbered]):
            add(f'missing_invoice:{number}', 'missing_invoice', 'invoices',
                f'رقم الفاتورة {number} غير موجود في تسلسل الفواتير',
                'قد تكون فاتورة لم تُسجَّل بعد، أو رقماً استُخدم لإشعار إرجاع.')

        # 2) رقم فاتورة مكرر
        by_number = {}
        for item in numbered:
            by_number.setdefault(item['number'], []).append(item)
        for number, items in sorted(by_number.items()):
            if len(items) > 1:
                add(f'duplicate_invoice:{number}', 'duplicate_invoice', 'invoices',
                    f'رقم الفاتورة {number} مكرر في {len(items)} فواتير',
                    ' ، '.join(f"{item['customer']} ({item['move_name']})" for item in items),
                    move_id=items[0]['move_id'])

        # 3) فاتورة بلا رقم
        for item in real_invoices:
            if not item['number']:
                add(f"invoice_no_number:{item['move_name']}:{item['customer']}:{item['amount']:.3f}",
                    'invoice_no_number', 'invoices',
                    f"فاتورة بدون رقم على {item['customer']} في القيد {item['move_name']}",
                    item['label'], customer_id=item['customer_id'], move_id=item['move_id'])

        # 4) مرتجع لا يشير إلى فاتورة موجودة لنفس العميل
        for item in invoices:
            if item['kind'] != 'return':
                continue
            matched = item['number'] and any(
                inv['number'] == item['number'] and inv['customer_id'] == item['customer_id'] for inv in real_invoices)
            if not matched:
                reference = f"الفاتورة {item['number']}" if item['number'] else 'فاتورة (بلا رقم في البيان)'
                add(f"return_unmatched:{item['move_name']}:{item['customer']}:{item['number'] or ''}",
                    'return_unmatched', 'invoices',
                    f"مرتجع على {item['customer']} يشير إلى {reference} غير موجودة لهذا العميل",
                    item['label'], customer_id=item['customer_id'], move_id=item['move_id'])

        # 5) أرقام ناقصة في تسلسل سندات القبض (أرقام السندات الرقمية فقط)
        receipt_numbers = []
        for item in receipts:
            name = normalize_digits(item['move_name'] or '').strip()
            if name.isdigit():
                receipt_numbers.append(int(name))
        for number in self._sequence_gaps(receipt_numbers):
            add(f'missing_receipt:{number}', 'missing_receipt', 'receipts',
                f'سند القبض رقم {number} غير موجود في تسلسل السندات',
                'قد يكون سنداً لم يُسجَّل بعد أو سنداً ملغى.')

        # 6) عميل رصيده دائن (دفع أكثر من المطلوب أو فاتورته لم تُسجَّل)
        for customer in customers:
            if customer['balance'] < -0.0005:
                add(f"credit_balance:{customer['code'] or customer['name']}", 'credit_balance', 'customers',
                    f"رصيد {customer['name']} دائن ({-customer['balance']:,.3f})",
                    'تحصيل أكبر من الفواتير المسجلة: قد تكون هناك فاتورة لم تُسجَّل أو دفعة مقدمة.',
                    customer_id=customer['id'])

        resolutions = {
            record.key: record
            for record in self.env['myaccounting.review.note'].search([('key', 'in', [n['key'] for n in notes])])
        }
        for note in notes:
            record = resolutions.get(note['key'])
            note.update({
                'resolved': bool(record),
                'resolution': record.resolution if record else '',
                'resolved_by': record.resolved_by.name if record else '',
                'resolved_on': fields.Datetime.to_string(record.resolved_on) if record and record.resolved_on else '',
            })
        return notes

    @api.model
    def resolve_note(self, key, resolution, kind=False, title=False):
        resolution = (resolution or '').strip()
        if not resolution:
            raise UserError('اكتب ملاحظة الحل قبل الحفظ.')
        Note = self.env['myaccounting.review.note']
        record = Note.search([('key', '=', key)], limit=1)
        vals = {'resolution': resolution, 'resolved_by': self.env.uid, 'resolved_on': fields.Datetime.now()}
        if record:
            record.write(vals)
        else:
            Note.create(dict(vals, key=key, kind=kind or False, title=title or False))
        return True

    @api.model
    def reopen_note(self, key):
        self.env['myaccounting.review.note'].search([('key', '=', key)]).unlink()
        return True
