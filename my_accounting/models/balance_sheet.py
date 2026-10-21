# -*- coding: utf-8 -*-
"""الميزانية السنوية: أرصدة الحسابات مصنَّفة إلى أصول وخصوم وحقوق ملكية،
ونتيجة السنة من الإيرادات والمصاريف.

التصنيف المبدئي من أول رقم في رمز الحساب الرئيسي (1 أصول، 2 خصوم،
3 حقوق ملكية، 4 إيرادات، 5 مصاريف)، ويبقى للمستخدم أن يصحّحه من الصفحة
لأن الرمز وحده لا يكفي دائماً.
"""
from odoo import api, fields, models

GROUPS = [
    ('asset', 'الأصول'),
    ('liability', 'الخصوم'),
    ('equity', 'حقوق الملكية'),
    ('income', 'الإيرادات'),
    ('expense', 'المصاريف'),
    ('none', 'خارج الميزانية'),
]

GROUP_LABELS = dict(GROUPS)

# الجانب الدائن يُعرض موجباً في الميزانية
CREDIT_SIDE = ('liability', 'equity', 'income')

BY_CODE = {'1': 'asset', '2': 'liability', '3': 'equity', '4': 'income', '5': 'expense'}


class MyAccountingAccountStatement(models.Model):
    _inherit = 'myaccounting.account'

    statement_group = fields.Selection(
        GROUPS, string='بند الميزانية', index=True,
        help='مكان الحساب في الميزانية السنوية. يُؤخذ مبدئياً من أول رقم في رمزه.')

    # ------------------------------------------------------------------
    # التصنيف
    # ------------------------------------------------------------------

    @api.model
    def _default_statement_group(self, code):
        return BY_CODE.get((code or '')[:1], 'none')

    def _statement_root(self):
        """الحساب الرئيسي الذي ينتمي إليه الحساب، فالتصنيف يكون على الرئيسي."""
        self.ensure_one()
        node = self
        while node.parent_id:
            node = node.parent_id
        return node

    @api.model
    def _statement_roots(self):
        roots = self.search([('parent_id', '=', False)], order='ledger_sequence, code')
        for root in roots:
            if not root.statement_group:
                root.statement_group = self._default_statement_group(root.code)
        return roots

    @api.model
    def get_statement_groups(self):
        """الحسابات الرئيسية وتصنيف كل منها، لصفحة الميزانية."""
        return {
            'groups': [{'key': key, 'label': label} for key, label in GROUPS],
            'roots': [{
                'id': root.id,
                'code': root.code or '',
                'name': root.name or '',
                'group': root.statement_group,
            } for root in self._statement_roots()],
        }

    @api.model
    def set_statement_group(self, account_id, group):
        if group not in GROUP_LABELS:
            return self.get_statement_groups()
        root = self.browse(int(account_id))._statement_root()
        root.statement_group = group
        return self.get_statement_groups()

    # ------------------------------------------------------------------
    # الميزانية
    # ------------------------------------------------------------------

    @api.model
    def _statement_balances(self, year, states):
        """رصيد كل حساب حتى نهاية السنة (تراكمي، فالميزانية ليست حركة فترة)."""
        moves = self.env['myaccounting.move'].search([
            ('state', 'in', states), ('ledger_year', '<=', int(year)),
        ])
        if not moves:
            return {}
        groups = self.env['myaccounting.move.line']._read_group(
            [('move_id', 'in', moves.ids), ('account_id', '!=', False)],
            ['account_id'], ['debit:sum', 'credit:sum'])
        return {account.id: (debit or 0.0) - (credit or 0.0)
                for account, debit, credit in groups}

    @api.model
    def get_balance_sheet(self, year=False, states=None, show_empty=False):
        states = [state for state in (states or []) if state in ('draft', 'incomplete', 'posted')] \
            or ['posted']
        Move = self.env['myaccounting.move']
        years = Move.get_ledger_years() if hasattr(Move, 'get_ledger_years') else []
        year = int(year or (years[0] if years else fields.Date.context_today(self).year))
        balances = self._statement_balances(year, states)

        roots = self._statement_roots()
        sections = {key: {'key': key, 'label': label, 'roots': [], 'total': 0.0}
                    for key, label in GROUPS}
        for root in roots:
            group = root.statement_group or 'none'
            sign = -1.0 if group in CREDIT_SIDE else 1.0
            accounts = self.search([('id', 'child_of', root.id)], order='code')
            lines = []
            total = 0.0
            for account in accounts:
                amount = round(sign * balances.get(account.id, 0.0), 3)
                total += amount
                if not amount and not show_empty:
                    continue
                lines.append({
                    'id': account.id,
                    'code': account.code or '',
                    'name': account.name or '',
                    'amount': amount,
                    'root': account.id == root.id,
                })
            total = round(total, 3)
            if not total and not lines and not show_empty:
                continue
            sections[group]['roots'].append({
                'id': root.id,
                'code': root.code or '',
                'name': root.name or '',
                'amount': total,
                'accounts': lines,
            })
            sections[group]['total'] = round(sections[group]['total'] + total, 3)

        income = sections['income']['total']
        expense = sections['expense']['total']
        profit = round(income - expense, 3)
        assets = sections['asset']['total']
        right = round(sections['liability']['total'] + sections['equity']['total'] + profit, 3)
        return {
            'year': year,
            'years': years,
            'sections': [sections[key] for key, _label in GROUPS],
            'income': income,
            'expense': expense,
            'profit': profit,
            'assets': assets,
            'right': right,
            'difference': round(assets - right, 3),
            'balanced': round(assets - right, 3) == 0,
            'outside': sections['none']['total'],
        }
