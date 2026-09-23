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
# عدة أرقام بعد كلمة الفاتورة في بيان سند القبض: "تحصيل ف 283 و 284" أو "فواتير 280، 282"
INVOICE_NUMBERS_RE = re.compile(
    r'(?:فواتير|مطالبات|فاتور[ةه]|مطالب[ةه]|(?<![\w])ف)\s*[.:#-]?\s*(?:رقم|ر)?\s*[.:#-]?\s*'
    r'(\d+(?:\s*(?:,|،|\+|&|و)\s*\d+)*)')


def extract_invoice_number(*labels):
    for label in labels:
        match = INVOICE_NUMBER_RE.search(normalize_digits(label or ''))
        if match:
            return int(match.group(1))
    return None


def extract_invoice_numbers(label):
    """كل أرقام الفواتير المذكورة في البيان، بالترتيب ودون تكرار."""
    numbers = []
    for match in INVOICE_NUMBERS_RE.finditer(normalize_digits(label or '')):
        for number in re.findall(r'\d+', match.group(1)):
            if int(number) not in numbers:
                numbers.append(int(number))
    return numbers


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
    def get_customers_data(self, include_drafts=False, ledger_month=False, ledger_year=False):
        """العملاء وفواتيرهم وتحصيلاتهم.

        - العميل: كل حساب تحت "الذمم" عليه فاتورة في قيد إيرادات أو تحصيل في سند قبض.
        - الفاتورة: بند مدين على حساب العميل داخل قيد إيرادات، ورقمها من البيان.
        - المرتجع: بند دائن على حساب العميل داخل قيد إيرادات.
        - الرصيد المستحق = إجمالي مدين الحساب − إجمالي دائنه، من كل القيود.
        - فلتر الشهر (شهر دفتر الأستاذ): الحركات تقتصر على ذلك الشهر، والرصيد يصبح
          الرصيد حتى نهايته، مع رصيد افتتاحي (ما قبله). الملاحظات تبقى على كل البيانات.
        """
        month = int(ledger_month) if ledger_month else 0
        year = int(ledger_year) if ledger_year else 0
        # سنة كاملة بلا شهر (صفحة التقارير): الحركات خلال السنة والرصيد حتى نهايتها
        whole_year = bool(year and not month)
        if whole_year:
            month = 12
        selected_period = year * 100 + month if month and year else 0

        def in_period(period):
            return period // 100 == year if whole_year else period == selected_period
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
                number = extract_invoice_number(line.name, next_revenue_label)
                cancels = None
                if kind == 'return':
                    # المرتجع له رقم خاص به مثل الفواتير: الرقم الأول في البيان رقمه، والثاني
                    # رقم الفاتورة الملغاة. مثال: "فاتورة رقم 279 مرتجع عن فاتورة رقم 277"
                    numbers = extract_invoice_numbers(line.name)
                    if numbers:
                        number = numbers[0]
                        cancels = numbers[1] if len(numbers) > 1 else None
                customer_ids.add(line.account_id.id)
                invoices.append({
                    'line_id': line.id,
                    'move_id': move.id,
                    'move_name': move.name,
                    'date': move.date and move.date.isoformat(),
                    'customer_id': line.account_id.id,
                    'customer': line.account_id.name,
                    'number': number,
                    'cancels': cancels,  # للمرتجع: رقم الفاتورة الملغاة
                    'label': line.name or '',
                    'amount': amount,
                    'kind': kind,
                    'state': move.state,
                    'period': move.ledger_year * 100 + int(move.ledger_month or 0),
                })

        for move in receipt_moves:
            per_customer = {}  # بنود نفس العميل في نفس السند تُجمع في سطر واحد
            for line in move.line_ids:
                if line.account_id.id in receivable_ids and line.credit:
                    customer_ids.add(line.account_id.id)
                    item = per_customer.get(line.account_id.id)
                    if item:
                        item['amount'] += line.credit
                        if line.name and line.name not in item['label']:
                            item['label'] = f"{item['label']} / {line.name}" if item['label'] else line.name
                        continue
                    per_customer[line.account_id.id] = {
                        'key': f'{move.id}-{line.account_id.id}',
                        'move_id': move.id,
                        'move_name': move.name,
                        'date': move.date and move.date.isoformat(),
                        'customer_id': line.account_id.id,
                        'customer': line.account_id.name,
                        'label': line.name or '',
                        'amount': line.credit,
                        'state': move.state,
                        'period': move.ledger_year * 100 + int(move.ledger_month or 0),
                    }
            receipts.extend(per_customer.values())

        self._apply_collections(invoices, receipts)

        # الرصيد من كل القيود (بما فيها أي تسويات يدوية) = مدين − دائن
        def balances_until(last_month=None):
            """الأرصدة حتى نهاية شهر معيّن من السنة المحددة (أو كل القيود عند None)."""
            if not customer_ids:
                return {}
            domain = [('account_id', 'in', list(customer_ids)), ('move_id.state', 'in', states)]
            if selected_period and last_month is not None:
                domain += ['|', ('move_id.ledger_year', '<', year),
                           '&', ('move_id.ledger_year', '=', year),
                           ('move_id.ledger_month', 'in', [str(m) for m in range(1, last_month + 1)] or ['_'])]
            groups = Line._read_group(domain, ['account_id'], ['debit:sum', 'credit:sum'])
            return {account.id: (debit or 0.0) - (credit or 0.0) for account, debit, credit in groups}

        balances = balances_until(month if selected_period else None)
        openings = balances_until(0 if whole_year else month - 1) if selected_period else {}
        current_balances = balances_until() if selected_period else balances

        # الملاحظات تُحسب على كل البيانات (تسلسل الأرقام لا يتقيد بالشهر)
        all_invoices, all_receipts = invoices, receipts
        if selected_period:
            invoices = [item for item in invoices if in_period(item['period'])]
            receipts = [item for item in receipts if in_period(item['period'])]

        customers = []
        for account in self.env['myaccounting.account'].browse(list(customer_ids)):
            own_invoices = [item for item in invoices if item['customer_id'] == account.id]
            invoiced = sum(item['amount'] for item in own_invoices if item['kind'] == 'invoice')
            returned = -sum(item['amount'] for item in own_invoices if item['kind'] == 'return')
            collected = sum(item['amount'] for item in receipts if item['customer_id'] == account.id)
            balance = balances.get(account.id, 0.0)
            opening = openings.get(account.id, 0.0)
            if selected_period and not own_invoices and not collected \
                    and abs(balance) < 0.0005 and abs(opening) < 0.0005:
                continue  # لا حركة في الشهر ولا رصيد
            customers.append({
                'id': account.id,
                'code': account.code or '',
                'name': account.name or '',
                'invoice_count': len([item for item in own_invoices if item['kind'] == 'invoice']),
                'open_count': len([item for item in own_invoices
                                   if item['kind'] == 'invoice' and item['status'] in ('open', 'partial')]),
                'unapplied': sum(item['unallocated'] for item in receipts if item['customer_id'] == account.id),
                'invoiced': invoiced,
                'returned': returned,
                'collected': collected,
                # حركات أخرى على الحساب خارج الفواتير والسندات (تسويات، أرصدة افتتاحية...)
                'other': balance - opening - (invoiced - returned - collected),
                'opening': opening,
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
            'opening': sum(item['opening'] for item in customers),
            'open_count': sum(item['open_count'] for item in customers),
            'remaining': sum(item['remaining'] for item in invoices if item['kind'] == 'invoice'),
        }
        return {
            'customers': customers,
            'invoices': invoices,
            'receipts': receipts,
            'totals': totals,
            'notes': self._review_notes(all_invoices, all_receipts, [
                {'id': account.id, 'code': account.code or '', 'name': account.name or '',
                 'balance': current_balances.get(account.id, 0.0)}
                for account in self.env['myaccounting.account'].browse(list(customer_ids))]),
        }

    @api.model
    def get_home_stats(self):
        """أرقام مربعات الصفحة الرئيسية (نفس أرقام صفحة العملاء، القيود المرحّلة فقط)."""
        data = self.get_customers_data()
        totals = data['totals']
        return {
            'invoiced': totals['invoiced'] - totals['returned'],
            'collected': totals['collected'],
            'balance': totals['balance'],
            'open_count': totals['open_count'],
            'remaining': totals['remaining'],
            'receipt_count': len({rec['move_id'] for rec in data['receipts']}),
            'customer_count': len([c for c in data['customers'] if c['balance'] > 0.0005]),
        }

    # ------------------------------------------------------------------
    # التحصيل: أي الفواتير دُفعت
    # ------------------------------------------------------------------

    @api.model
    def _apply_collections(self, invoices, receipts):
        """يحدد لكل فاتورة المحصّل والمتبقي وحالتها، ولكل سند الفواتير التي غطّاها.

        الترتيب: (1) المرتجع يُطرح من فاتورته (نفس الرقم ونفس العميل).
        (2) التخصيص اليدوي للسندات. (3) السندات غير المخصّصة (والمرتجعات بلا
        فاتورة) تُوزَّع تلقائياً على أقدم الفواتير المفتوحة. أما السند المخصّص يدوياً
        فما يزيد منه يبقى "دفعة غير مخصّصة". لا يغيّر هذا شيئاً في القيود أو الأرصدة.
        """
        real = [item for item in invoices if item['kind'] == 'invoice']
        by_number = {}
        for inv in real:
            inv.update({'net': inv['amount'], 'collected': 0.0, 'returned_amount': 0.0, 'payments': []})
            if inv['number']:
                by_number.setdefault((inv['customer_id'], inv['number']), []).append(inv)
        for item in invoices:
            if item['kind'] == 'return':
                item.update({'status': False, 'collected': 0.0, 'remaining': 0.0, 'payments': []})

        def apply(inv, amount, source, manual):
            take = min(amount, inv['net'] - inv['collected'])
            if take <= 0.0005:
                return 0.0
            inv['collected'] += take
            inv['payments'].append({'receipt': source, 'amount': take, 'manual': manual})
            return take

        auto_pool = {}  # customer_id -> [(receipt or None, amount)]

        # 1) المرتجعات
        for item in invoices:
            if item['kind'] != 'return':
                continue
            credit = -item['amount']
            for inv in by_number.get((item['customer_id'], item['cancels']), []) if item['cancels'] else []:
                take = min(credit, inv['net'])
                inv['net'] -= take
                inv['returned_amount'] += take
                credit -= take
            if credit > 0.0005:
                auto_pool.setdefault(item['customer_id'], []).append((None, credit))

        # 2) التخصيص اليدوي
        manual = {}
        allocations = self.env['myaccounting.receipt.allocation'].search(
            [('receipt_move_id', 'in', [rec['move_id'] for rec in receipts] or [0])])
        for allocation in allocations:
            manual.setdefault((allocation.receipt_move_id.id, allocation.customer_id.id), []).append(
                (allocation.invoice_number, allocation.amount))

        ordered_receipts = sorted(receipts, key=lambda rec: (rec['date'] or '', rec['move_name'] or ''))
        for rec in ordered_receipts:
            rec.update({'allocations': [], 'mode': 'auto', 'unallocated': 0.0,
                        'suggested': extract_invoice_numbers(rec['label'])})
            remaining = rec['amount']
            rec_manual = manual.get((rec['move_id'], rec['customer_id']))
            if rec_manual:
                rec['mode'] = 'manual'
                for number, amount in rec_manual:
                    for inv in by_number.get((rec['customer_id'], number), []):
                        take = apply(inv, min(amount, remaining), rec['move_name'], True)
                        if take:
                            rec['allocations'].append({'number': number, 'amount': take, 'manual': True})
                            amount -= take
                            remaining -= take
                rec['unallocated'] = max(remaining, 0.0) if remaining > 0.0005 else 0.0
            elif remaining > 0.0005:
                auto_pool.setdefault(rec['customer_id'], []).append((rec, remaining))

        # 3) التوزيع التلقائي على أقدم الفواتير
        for customer_id, sources in auto_pool.items():
            open_invoices = sorted(
                [inv for inv in real if inv['customer_id'] == customer_id],
                key=lambda inv: (inv['number'] is None, inv['number'] or 0, inv['date'] or '', inv['line_id']))
            for rec, amount in sources:
                for inv in open_invoices:
                    if amount <= 0.0005:
                        break
                    take = apply(inv, amount, rec['move_name'] if rec else 'مرتجع', False)
                    if take and rec:
                        rec['allocations'].append({'number': inv['number'], 'amount': take, 'manual': False})
                    amount -= take
                if rec and amount > 0.0005:
                    rec['unallocated'] += amount

        for inv in real:
            inv['remaining'] = max(inv['net'] - inv['collected'], 0.0)
            if inv['net'] <= 0.0005:
                inv['status'] = 'returned'
            elif inv['remaining'] <= 0.0005:
                inv['status'] = 'paid'
            elif inv['collected'] > 0.0005:
                inv['status'] = 'partial'
            else:
                inv['status'] = 'open'

    @api.model
    def _receipt_amount(self, move_id, customer_id):
        move = self.env['myaccounting.move'].browse(move_id).exists()
        if not move or move.move_type != 'receipt':
            raise UserError('سند القبض غير موجود.')
        return move, sum(move.line_ids.filtered(lambda line: line.account_id.id == customer_id).mapped('credit'))

    @api.model
    def _allocation_candidates(self, move_id, customer_id):
        """فواتير العميل مع المتاح للتخصيص من هذا السند
        (قيمتها بعد المرتجعات − ما خُصِّص لها يدوياً من سندات أخرى)."""
        data = self.get_customers_data(include_drafts=True)
        invoices = [inv for inv in data['invoices']
                    if inv['kind'] == 'invoice' and inv['customer_id'] == customer_id and inv['number']]
        other_manual = {}
        for allocation in self.env['myaccounting.receipt.allocation'].search(
                [('customer_id', '=', customer_id), ('receipt_move_id', '!=', move_id)]):
            other_manual[allocation.invoice_number] = other_manual.get(allocation.invoice_number, 0.0) + allocation.amount
        candidates = {}
        for inv in invoices:
            entry = candidates.setdefault(inv['number'], {
                'number': inv['number'], 'date': inv['date'], 'label': inv['label'], 'net': 0.0})
            entry['net'] += inv['net']
        for entry in candidates.values():
            entry['available'] = max(entry['net'] - other_manual.get(entry['number'], 0.0), 0.0)
        return sorted(candidates.values(), key=lambda entry: entry['number'])

    @api.model
    def get_receipt_allocation(self, move_id, customer_id):
        move, amount = self._receipt_amount(move_id, customer_id)
        current = {allocation.invoice_number: allocation.amount
                   for allocation in self.env['myaccounting.receipt.allocation'].search(
                       [('receipt_move_id', '=', move_id), ('customer_id', '=', customer_id)])}
        labels = ' '.join(move.line_ids.filtered(lambda line: line.account_id.id == customer_id).mapped('name'))
        candidates = self._allocation_candidates(move_id, customer_id)
        for entry in candidates:
            entry['current'] = current.get(entry['number'], 0.0)
        return {
            'move_name': move.name,
            'date': move.date and move.date.isoformat(),
            'customer': self.env['myaccounting.account'].browse(customer_id).name,
            'label': labels,
            'amount': amount,
            'has_allocation': bool(current),
            'suggested': extract_invoice_numbers(labels),
            'invoices': candidates,
        }

    @api.model
    def save_receipt_allocation(self, move_id, customer_id, allocations):
        """allocations: [{'number': int, 'amount': float}] — قائمة فارغة = إلغاء التخصيص
        (يعود السند للتوزيع التلقائي)."""
        _move, receipt_amount = self._receipt_amount(move_id, customer_id)
        candidates = {entry['number']: entry for entry in self._allocation_candidates(move_id, customer_id)}
        vals_list, total = [], 0.0
        for allocation in allocations or []:
            number = int(allocation.get('number') or 0)
            amount = round(float(allocation.get('amount') or 0.0), 3)
            if amount <= 0:
                continue
            entry = candidates.get(number)
            if not entry:
                raise UserError(f'الفاتورة رقم {number} غير موجودة لهذا العميل.')
            if amount > entry['available'] + 0.0005:
                raise UserError(f"المبلغ المخصّص للفاتورة {number} ({amount:,.3f}) أكبر من المتبقي عليها "
                                f"({entry['available']:,.3f}).")
            total += amount
            vals_list.append({'receipt_move_id': move_id, 'customer_id': customer_id,
                              'invoice_number': number, 'amount': amount})
        if total > receipt_amount + 0.0005:
            raise UserError(f'مجموع التخصيص ({total:,.3f}) أكبر من مبلغ السند ({receipt_amount:,.3f}).')
        Allocation = self.env['myaccounting.receipt.allocation']
        Allocation.search([('receipt_move_id', '=', move_id), ('customer_id', '=', customer_id)]).unlink()
        Allocation.create(vals_list)
        return True

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
        # الفواتير والمرتجعات تشترك في تسلسل الأرقام نفسه
        numbered = [item for item in invoices if item['number']]

        # 1) أرقام ناقصة في تسلسل الفواتير والمرتجعات
        for number in self._sequence_gaps([item['number'] for item in numbered]):
            add(f'missing_invoice:{number}', 'missing_invoice', 'invoices',
                f'رقم الفاتورة {number} غير موجود في تسلسل الفواتير',
                'قد تكون فاتورة أو مرتجعاً لم يُسجَّل بعد.')

        # 2) رقم مكرر (بين الفواتير والمرتجعات)
        by_number = {}
        for item in numbered:
            by_number.setdefault(item['number'], []).append(item)
        for number, items in sorted(by_number.items()):
            if len(items) > 1:
                add(f'duplicate_invoice:{number}', 'duplicate_invoice', 'invoices',
                    f'الرقم {number} مستخدم في {len(items)} مستندات',
                    ' ، '.join(f"{'مرتجع' if item['kind'] == 'return' else 'فاتورة'} {item['customer']} "
                               f"({item['move_name']})" for item in items),
                    move_id=items[0]['move_id'])

        # 3) فاتورة بلا رقم
        for item in real_invoices:
            if not item['number']:
                add(f"invoice_no_number:{item['move_name']}:{item['customer']}:{item['amount']:.3f}",
                    'invoice_no_number', 'invoices',
                    f"فاتورة بدون رقم على {item['customer']} في القيد {item['move_name']}",
                    item['label'], customer_id=item['customer_id'], move_id=item['move_id'])

        # 4) مرتجع لا يذكر الفاتورة الملغاة، أو يذكر فاتورة غير موجودة لنفس العميل
        for item in invoices:
            if item['kind'] != 'return':
                continue
            own = f" رقم {item['number']}" if item['number'] else ''
            if not item['cancels']:
                add(f"return_no_ref:{item['move_name']}:{item['customer']}:{item['number'] or ''}",
                    'return_unmatched', 'invoices',
                    f"المرتجع{own} على {item['customer']} لا يذكر رقم الفاتورة الملغاة",
                    f"البيان: {item['label']} — الصيغة المتوقعة: \"فاتورة رقم (رقم المرتجع) مرتجع عن فاتورة رقم (الفاتورة الملغاة)\"",
                    customer_id=item['customer_id'], move_id=item['move_id'])
                continue
            matched = any(inv['number'] == item['cancels'] and inv['customer_id'] == item['customer_id']
                          for inv in real_invoices)
            if not matched:
                add(f"return_unmatched:{item['move_name']}:{item['customer']}:{item['cancels']}",
                    'return_unmatched', 'invoices',
                    f"المرتجع{own} على {item['customer']} يلغي الفاتورة {item['cancels']} غير الموجودة لهذا العميل",
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

        # 6) سند قبض غير مخصّص لعميل لديه أكثر من فاتورة (التوزيع التلقائي قد لا يطابق الواقع)
        invoice_counts = {}
        for item in real_invoices:
            invoice_counts[item['customer_id']] = invoice_counts.get(item['customer_id'], 0) + 1
        for rec in receipts:
            if rec.get('mode') == 'auto' and invoice_counts.get(rec['customer_id'], 0) > 1:
                applied = ' ، '.join(f"ف {a['number']} ({a['amount']:,.3f})" for a in rec['allocations'] if a['number'])
                add(f"receipt_unallocated:{rec['move_name']}:{rec['customer']}", 'receipt_unallocated', 'receipts',
                    f"سند القبض {rec['move_name']} ({rec['customer']}) غير مخصّص لفواتير",
                    f"وُزِّع تلقائياً على الأقدم: {applied}" if applied else 'لم يُطبَّق على أي فاتورة.',
                    customer_id=rec['customer_id'], move_id=rec['move_id'])

        # 7) عميل رصيده دائن (دفع أكثر من المطلوب أو فاتورته لم تُسجَّل)
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
