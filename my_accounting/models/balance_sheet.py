# -*- coding: utf-8 -*-
"""الميزانية السنوية: أرصدة الحسابات مصنَّفة في أبواب، ونتيجة السنة.

الأبواب بيانات لا ثوابت في الكود، فيضيف المستخدم ما يلزمه (ذمم مدينة،
ذمم دائنة…) ويعدّل ويحذف. وتصنيف الحساب يُورَّث من أبيه ما لم يُحدَّد له
تصنيف خاص، فيجوز أن يبقى الحساب الرئيسي بلا تصنيف وتُصنَّف فروعه كلٌّ
في بابه.
"""
from odoo import api, fields, models
from odoo.exceptions import UserError

SIDES = [('debit', 'مدين'), ('credit', 'دائن')]
KINDS = [('balance', 'الميزانية'), ('result', 'نتيجة السنة')]

# الأبواب المبدئية عند أول فتح للصفحة
DEFAULT_GROUPS = [
    ('الأصول', 'balance', 'debit', 10, '1'),
    ('الخصوم', 'balance', 'credit', 20, '2'),
    ('حقوق الملكية', 'balance', 'credit', 30, '3'),
    ('الإيرادات', 'result', 'credit', 40, '4'),
    ('المصاريف', 'result', 'debit', 50, '5'),
]


class MyAccountingStatementGroup(models.Model):
    _name = 'myaccounting.statement.group'
    _description = 'باب من أبواب الميزانية'
    _order = 'sequence, id'

    name = fields.Char(string='الاسم', required=True)
    sequence = fields.Integer(string='الترتيب', default=50)
    kind = fields.Selection(KINDS, string='الموضع', required=True, default='balance',
                            help='الميزانية: أصول وخصوم وحقوق ملكية. '
                                 'نتيجة السنة: إيرادات ومصاريف.')
    side = fields.Selection(SIDES, string='الطبيعة', required=True, default='debit',
                            help='مدين: يُعرض الرصيد المدين موجباً. '
                                 'دائن: يُعرض الرصيد الدائن موجباً.')
    code_prefix = fields.Char(string='بادئة الرمز',
                              help='أول رقم في رمز الحساب الذي يُصنَّف هنا تلقائياً '
                                   'عند أول مرة. لا يُستعمل بعد ذلك.')
    account_ids = fields.One2many('myaccounting.account', 'statement_group_id',
                                  string='الحسابات')

    @api.model
    def _ensure(self):
        """ينشئ الأبواب المبدئية إن لم يكن ثمة أبواب بعد."""
        groups = self.search([])
        if not groups:
            groups = self.create([{
                'name': name, 'kind': kind, 'side': side,
                'sequence': sequence, 'code_prefix': prefix,
            } for name, kind, side, sequence, prefix in DEFAULT_GROUPS])
            self.env['myaccounting.account']._seed_statement_groups(groups)
        return groups

    @api.model
    def get_groups(self):
        return [{
            'id': group.id,
            'name': group.name,
            'kind': group.kind,
            'side': group.side,
            'sequence': group.sequence,
            'accounts': len(group.account_ids),
        } for group in self._ensure()]

    @api.model
    def save_group(self, group_id, values):
        """يضيف باباً جديداً (group_id فارغ) أو يعدّل باباً قائماً."""
        allowed = ('name', 'kind', 'side', 'sequence')
        data = {key: values[key] for key in allowed if key in values}
        if 'name' in data:
            data['name'] = (data['name'] or '').strip()
            if not data['name']:
                raise UserError('لا بدّ للباب من اسم.')
        if group_id:
            self.browse(int(group_id)).write(data)
        else:
            self.create(data)
        return self.get_groups()

    @api.model
    def delete_group(self, group_id):
        """يحذف الباب، وتعود حساباته بلا تصنيف خاص فترث تصنيف آبائها."""
        group = self.browse(int(group_id))
        group.account_ids.statement_group_id = False
        group.unlink()
        return self.get_groups()


class MyAccountingAccountStatement(models.Model):
    _inherit = 'myaccounting.account'

    statement_group_id = fields.Many2one(
        'myaccounting.statement.group', string='باب الميزانية', index=True,
        ondelete='set null',
        help='اتركه فارغاً ليرث الحساب تصنيف أبيه.')
    opening_balance = fields.Float(
        string='الرصيد الافتتاحي', digits=(16, 3),
        help='الرصيد الذي يبدأ به الحساب قبل قيود النظام. '
             'موجب للرصيد المدين، وسالب للرصيد الدائن.')

    # ------------------------------------------------------------------
    # التصنيف
    # ------------------------------------------------------------------

    @api.model
    def _seed_statement_groups(self, groups):
        """تصنيف أوّلي للحسابات الرئيسية من أول رقم في رمزها."""
        by_prefix = {group.code_prefix: group for group in groups if group.code_prefix}
        for root in self.search([('parent_id', '=', False)]):
            group = by_prefix.get((root.code or '')[:1])
            if group and not root.statement_group_id:
                root.statement_group_id = group.id

    def _effective_group(self):
        """تصنيف الحساب: تصنيفه هو، وإلا أقرب أب مصنَّف، وإلا لا شيء."""
        self.ensure_one()
        node = self
        while node:
            if node.statement_group_id:
                return node.statement_group_id
            node = node.parent_id
        return self.env['myaccounting.statement.group']

    @api.model
    def get_statement_accounts(self):
        """شجرة الحسابات مع تصنيف كلٍّ منها — الخاص والموروث."""
        self.env['myaccounting.statement.group']._ensure()
        accounts = self.search([], order='parent_path')
        rows = []
        for account in accounts.sorted(key=lambda a: (a.code_path or a.code or '')):
            effective = account._effective_group()
            rows.append({
                'id': account.id,
                'code': account.code or '',
                'name': account.name or '',
                'level': account.level or 0,
                'group_id': account.statement_group_id.id or False,
                'effective_id': effective.id or False,
                'effective': effective.name or '',
                'inherited': bool(effective) and not account.statement_group_id,
                'opening': account.opening_balance or 0.0,
            })
        return rows

    @api.model
    def set_statement_account(self, account_id, group_id):
        account = self.browse(int(account_id))
        account.statement_group_id = int(group_id) if group_id else False
        return self.get_statement_accounts()

    @api.model
    def set_opening_balance(self, account_id, amount):
        account = self.browse(int(account_id))
        account.opening_balance = float(amount or 0.0)
        return self.get_statement_accounts()

    # ------------------------------------------------------------------
    # الميزانية
    # ------------------------------------------------------------------

    @api.model
    def _statement_balances(self, year, states):
        """رصيد كل حساب حتى نهاية السنة: الافتتاحي زائد القيود المتراكمة."""
        balances = {account.id: account.opening_balance or 0.0
                    for account in self.search([('opening_balance', '!=', 0.0)])}
        moves = self.env['myaccounting.move'].search([
            ('state', 'in', states), ('ledger_year', '<=', int(year)),
        ])
        if moves:
            groups = self.env['myaccounting.move.line']._read_group(
                [('move_id', 'in', moves.ids), ('account_id', '!=', False)],
                ['account_id'], ['debit:sum', 'credit:sum'])
            for account, debit, credit in groups:
                balances[account.id] = balances.get(account.id, 0.0) \
                    + (debit or 0.0) - (credit or 0.0)
        return balances

    @api.model
    def get_balance_sheet(self, year=False, states=None, show_empty=False):
        states = [state for state in (states or []) if state in ('draft', 'incomplete', 'posted')] \
            or ['posted']
        Group = self.env['myaccounting.statement.group']
        groups = Group._ensure()
        Move = self.env['myaccounting.move']
        years = Move.get_ledger_years()
        year = int(year or (years[0] if years else fields.Date.context_today(self).year))
        balances = self._statement_balances(year, states)

        sections = {group.id: {
            'id': group.id, 'label': group.name, 'kind': group.kind,
            'side': group.side, 'lines': [], 'total': 0.0,
        } for group in groups}
        unclassified = {'id': 0, 'label': 'غير مصنَّف', 'kind': 'none', 'side': 'debit',
                        'lines': [], 'total': 0.0}

        accounts = self.search([], order='code')
        displayed = {}
        for account in accounts:
            group = account._effective_group()
            section = sections.get(group.id, unclassified) if group else unclassified
            sign = -1.0 if (group and group.side == 'credit') else 1.0
            amount = round(sign * balances.get(account.id, 0.0), 3)
            displayed[account.id] = amount
            section['total'] = round(section['total'] + amount, 3)
            if not amount and not show_empty:
                continue
            section['lines'].append({
                'id': account.id,
                'code': account.code or '',
                'name': account.name or '',
                'level': account.level or 0,
                'amount': amount,
                'inherited': not account.statement_group_id,
            })

        # مراجع المعادلات: الحساب برمزه ومعه فروعه، والباب باسمه
        children = {}
        for account in accounts:
            children.setdefault(account.parent_id.id, []).append(account)

        def subtree(account):
            total = displayed.get(account.id, 0.0)
            for child in children.get(account.id, []):
                total += subtree(child)
            return total

        account_values = {account.code: round(subtree(account), 3)
                          for account in accounts if account.code}

        ordered = [sections[group.id] for group in groups]
        if unclassified['lines'] or round(unclassified['total'], 3):
            ordered.append(unclassified)

        left = [s for s in ordered if s['kind'] == 'balance' and s['side'] == 'debit']
        right = [s for s in ordered if s['kind'] == 'balance' and s['side'] == 'credit']
        income = [s for s in ordered if s['kind'] == 'result' and s['side'] == 'credit']
        expense = [s for s in ordered if s['kind'] == 'result' and s['side'] == 'debit']
        other = [s for s in ordered if s['kind'] == 'none']

        group_values = {section['label']: section['total'] for section in ordered}
        formulas = self.env['myaccounting.statement.line'].compute_lines(
            account_values, group_values)
        for section in ordered:
            section['formulas'] = [item for item in formulas
                                   if item['placement'] == 'group'
                                   and item['group_id'] == section['id']]

        assets = round(sum(s['total'] for s in left), 3)
        income_total = round(sum(s['total'] for s in income), 3)
        expense_total = round(sum(s['total'] for s in expense), 3)
        profit = round(income_total - expense_total, 3)
        right_total = round(sum(s['total'] for s in right) + profit, 3)
        return {
            'year': year,
            'years': years,
            'left': left,
            'right': right,
            'income': income,
            'expense': expense,
            'other': other,
            'income_total': income_total,
            'expense_total': expense_total,
            'profit': profit,
            'assets': assets,
            'right_total': right_total,
            'other_total': round(sum(s['total'] for s in other), 3),
            'difference': round(assets - right_total, 3),
            'balanced': round(assets - right_total, 3) == 0,
            # البنود المحسوبة لا تدخل المجاميع، فهي مشتقة منها
            'left_formulas': [item for item in formulas
                              if item['placement'] == 'side' and item['side'] == 'debit'],
            'right_formulas': [item for item in formulas
                               if item['placement'] == 'side' and item['side'] == 'credit'],
            'bottom_formulas': [item for item in formulas if item['placement'] == 'bottom'],
        }

    @api.model
    def get_formula_references(self):
        """ما يصلح أن يُكتب داخل معادلة، ليُدرجه المستخدم بنقرة."""
        Group = self.env['myaccounting.statement.group']
        return {
            'accounts': [{'token': '[%s]' % account.code, 'label': account.name or ''}
                         for account in self.search([('code', '!=', False)], order='code')],
            'groups': [{'token': '{%s}' % group.name, 'label': ''}
                       for group in Group._ensure()],
            'lines': [{'token': '<%s>' % line.name, 'label': ''}
                      for line in self.env['myaccounting.statement.line'].search([])
                      if line.name],
        }
