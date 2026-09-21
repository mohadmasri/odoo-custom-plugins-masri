from datetime import date

from odoo import api, fields, models

TOP_SLICES = 8  # أكثر من هذا في الرسم الدائري يُجمع تحت "أخرى"
AGING_BUCKETS = [(0, 30, '0 – 30 يوماً'), (31, 60, '31 – 60 يوماً'), (61, 90, '61 – 90 يوماً'),
                 (91, None, 'أكثر من 90 يوماً')]


def normalize_name(name):
    return (name or '').replace('إ', 'ا').replace('أ', 'ا').replace('آ', 'ا')


class MyAccountingReports(models.AbstractModel):
    """بيانات صفحة التقارير (رسوم بيانية). التصنيف حسب أسماء الحسابات الرئيسية:
    الإيرادات، المصاريف (كل حساب رئيسي يحوي "مصاريف")، البنك الأهلي، ضريبة المبيعات،
    الضمان الاجتماعي. الفترة حسب شهر/سنة دفتر الأستاذ."""
    _name = 'myaccounting.reports'
    _description = 'التقارير والرسوم البيانية'

    @api.model
    def _roots(self, keyword):
        return self.env['myaccounting.account'].search([('parent_id', '=', False)]).filtered(
            lambda account: keyword in normalize_name(account.name))

    @api.model
    def _top_slices(self, items):
        """items: [(label, value, extra)] → أكبر TOP_SLICES والباقي "أخرى"."""
        items = sorted([item for item in items if item[1] > 0.0005], key=lambda item: -item[1])
        if len(items) > TOP_SLICES:
            rest = sum(item[1] for item in items[TOP_SLICES - 1:])
            items = items[:TOP_SLICES - 1] + [('أخرى', rest, None)]
        return [{'label': label, 'value': round(value, 3), 'id': extra} for label, value, extra in items]

    @api.model
    def get_reports_data(self, year=False, month=False, include_drafts=False):
        states = ['posted', 'draft', 'incomplete'] if include_drafts else ['posted']
        Move = self.env['myaccounting.move']
        years = sorted({group[0] for group in Move._read_group([('state', 'in', states)], ['ledger_year'])
                        if group[0]})
        year = int(year) if year else (years[-1] if years else date.today().year)
        month = int(month) if month else 0
        in_period = (lambda y, m: y == year and m == month) if month else (lambda y, m: y == year)

        Account = self.env['myaccounting.account']
        revenue_roots = self._roots('ايراد')
        expense_roots = self._roots('مصاريف') | self._roots('مصروف')
        bank_roots = self._roots('اهلي')
        tax_roots = self._roots('ضريب')
        ss_roots = self._roots('ضمان')

        def subtree(roots):
            return set(Account.search([('id', 'child_of', roots.ids)]).ids) if roots else set()

        revenue_ids = subtree(revenue_roots)
        bank_ids = subtree(bank_roots)
        tax_ids = subtree(tax_roots)
        ss_ids = subtree(ss_roots)
        # كل حساب مصاريف ← (الحساب الرئيسي، الحساب الفرعي المباشر تحت الرئيسي)
        expense_map = {}
        for root in expense_roots:
            for account in Account.search([('id', 'child_of', root.id)]):
                top = account
                while top.parent_id and top.parent_id != root:
                    top = top.parent_id
                expense_map[account.id] = (root, top)
        revenue_top = {}
        for root in revenue_roots:
            for account in Account.search([('id', 'child_of', root.id)]):
                top = account
                while top.parent_id and top.parent_id != root:
                    top = top.parent_id
                revenue_top[account.id] = top

        watched = revenue_ids | bank_ids | tax_ids | ss_ids | set(expense_map)
        lines = self.env['myaccounting.move.line'].search([
            ('move_id.state', 'in', states), ('move_id.ledger_year', '<=', year),
            ('account_id', 'in', list(watched) or [0]),
        ])

        zeros = lambda: [0.0] * 12  # noqa: E731
        monthly = {'revenue': zeros(), 'expenses': zeros(), 'tax': zeros(), 'ss': zeros(), 'bank': zeros()}
        expense_by_root_monthly = {root.id: zeros() for root in expense_roots}
        bank_opening = 0.0
        period_revenue = period_expenses = 0.0
        expense_by_root, expense_by_child, revenue_by_child = {}, {}, {}

        for line in lines:
            move = line.move_id
            line_year, line_month = move.ledger_year, int(move.ledger_month or 0)
            account_id = line.account_id.id
            net_debit = line.debit - line.credit
            if account_id in bank_ids:
                if line_year < year:
                    bank_opening += net_debit
                elif 1 <= line_month <= 12:
                    monthly['bank'][line_month - 1] += net_debit
            if line_year != year or not 1 <= line_month <= 12:
                continue
            index = line_month - 1
            if account_id in revenue_ids:
                monthly['revenue'][index] -= net_debit
                if in_period(line_year, line_month):
                    period_revenue -= net_debit
                    top = revenue_top.get(account_id)
                    revenue_by_child[top.id] = revenue_by_child.get(top.id, 0.0) - net_debit
            if account_id in expense_map:
                root, top = expense_map[account_id]
                monthly['expenses'][index] += net_debit
                expense_by_root_monthly[root.id][index] += net_debit
                if in_period(line_year, line_month):
                    period_expenses += net_debit
                    expense_by_root[root.id] = expense_by_root.get(root.id, 0.0) + net_debit
                    key = (root.id, top.id)
                    expense_by_child[key] = expense_by_child.get(key, 0.0) + net_debit
            if account_id in tax_ids:
                monthly['tax'][index] -= net_debit
            if account_id in ss_ids:
                monthly['ss'][index] -= net_debit

        # رصيد البنك في نهاية كل شهر
        bank_balance, running = [], bank_opening
        for value in monthly['bank']:
            running += value
            bank_balance.append(round(running, 3))

        # ------------------------------------------------------------ العملاء
        Customers = self.env['myaccounting.customers']
        period_data = Customers.get_customers_data(include_drafts, month or False, year)
        all_data = Customers.get_customers_data(include_drafts)

        customer_balances = sorted(
            [c for c in period_data['customers'] if c['balance'] > 0.0005], key=lambda c: -c['balance'])
        status_summary = {status: {'count': 0, 'amount': 0.0} for status in ('paid', 'partial', 'open')}
        for inv in period_data['invoices']:
            if inv['kind'] == 'invoice' and inv['status'] in status_summary:
                status_summary[inv['status']]['count'] += 1
                status_summary[inv['status']]['amount'] += inv['amount'] - inv.get('returned_amount', 0.0)

        billed_monthly, collected_monthly = zeros(), zeros()
        for inv in all_data['invoices']:
            if inv['period'] // 100 == year and 1 <= inv['period'] % 100 <= 12:
                billed_monthly[inv['period'] % 100 - 1] += inv['amount']  # المرتجع سالب
        for rec in all_data['receipts']:
            if rec['period'] // 100 == year and 1 <= rec['period'] % 100 <= 12:
                collected_monthly[rec['period'] % 100 - 1] += rec['amount']

        today = fields.Date.context_today(self)
        aging = [{'label': label, 'amount': 0.0, 'count': 0} for _low, _high, label in AGING_BUCKETS]
        for inv in all_data['invoices']:
            if inv['kind'] != 'invoice' or inv['remaining'] <= 0.0005 or not inv['date']:
                continue
            days = (today - fields.Date.from_string(inv['date'])).days
            for bucket, (low, high, _label) in zip(aging, AGING_BUCKETS):
                if days >= low and (high is None or days <= high):
                    bucket['amount'] += inv['remaining']
                    bucket['count'] += 1
                    break

        invoiced_by_customer = self._top_slices(
            [(c['name'], c['invoiced'] - c['returned'], c['id']) for c in period_data['customers']])

        round_list = lambda values: [round(value, 3) for value in values]  # noqa: E731
        return {
            'year': year,
            'month': month,
            'years': years or [year],
            'cards': {
                'revenue': round(period_revenue, 3),
                'expenses': round(period_expenses, 3),
                'profit': round(period_revenue - period_expenses, 3),
                'receivable': round(period_data['totals']['balance'], 3),
            },
            'monthly': {
                'revenue': round_list(monthly['revenue']),
                'expenses': round_list(monthly['expenses']),
                'profit': round_list([r - e for r, e in zip(monthly['revenue'], monthly['expenses'])]),
                'expenses_by_root': [{'label': root.name, 'values': round_list(expense_by_root_monthly[root.id])}
                                     for root in expense_roots],
                'billed': round_list(billed_monthly),
                'collected': round_list(collected_monthly),
                'bank_balance': bank_balance,
                'bank_opening': round(bank_opening, 3),
                'tax': round_list(monthly['tax']),
                'ss': round_list(monthly['ss']),
            },
            'bank_name': ' / '.join(bank_roots.mapped('name')) or 'البنك',
            'expense_roots': self._top_slices(
                [(root.name, expense_by_root.get(root.id, 0.0), root.id) for root in expense_roots]),
            'expense_children': [{
                'root': root.name,
                'slices': self._top_slices([
                    (Account.browse(child_id).name, value, child_id)
                    for (root_id, child_id), value in expense_by_child.items() if root_id == root.id]),
            } for root in expense_roots],
            'revenue_sources': self._top_slices(
                [(Account.browse(account_id).name, value, account_id) for account_id, value in revenue_by_child.items()]),
            'revenue_has_children': any(root.child_ids for root in revenue_roots),
            'customer_balances': [{'id': c['id'], 'label': c['name'], 'value': round(c['balance'], 3)}
                                  for c in customer_balances[:12]],
            'invoice_status': [{'status': status, 'count': info['count'], 'amount': round(info['amount'], 3)}
                               for status, info in status_summary.items()],
            'aging': [dict(bucket, amount=round(bucket['amount'], 3)) for bucket in aging],
            'invoiced_by_customer': invoiced_by_customer,
            'balances': {
                'bank': bank_balance[month - 1 if month else 11],
                'tax': round(-sum(line.debit - line.credit for line in lines if line.account_id.id in tax_ids
                                  and (line.move_id.ledger_year, int(line.move_id.ledger_month or 0))
                                  <= (year, month or 12)), 3),
                'ss': round(-sum(line.debit - line.credit for line in lines if line.account_id.id in ss_ids
                                 and (line.move_id.ledger_year, int(line.move_id.ledger_month or 0))
                                 <= (year, month or 12)), 3),
            },
        }

    # ------------------------------------------------------------------
    # التقارير المثبّتة في الصفحة الرئيسية (لكل مستخدم)
    # ------------------------------------------------------------------

    def _home_reports_param(self):
        return f'my_accounting.home_reports.{self.env.uid}'

    @api.model
    def get_home_report_keys(self):
        value = self.env['ir.config_parameter'].sudo().get_param(self._home_reports_param(), '')
        return [key for key in value.split(',') if key]

    @api.model
    def set_home_report(self, key, pinned):
        keys = [k for k in self.get_home_report_keys() if k != key]
        if pinned:
            keys.append(key)  # الترتيب في الرئيسية = ترتيب التثبيت
        self.env['ir.config_parameter'].sudo().set_param(self._home_reports_param(), ','.join(keys))
        return keys

    @api.model
    def get_home_reports(self):
        """المفاتيح المثبّتة + بيانات السنة الحالية (بلا شهر) إن وُجد ما يُعرض."""
        keys = self.get_home_report_keys()
        return {'keys': keys, 'data': self.get_reports_data() if keys else None}
