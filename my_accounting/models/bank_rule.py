# -*- coding: utf-8 -*-
"""قاموس حركات البنك: ما تسمّيه أنت وما تسجّله لكل نوع حركة.

كشف البنك مكتوب بمصطلحات البنك ("Cash Margin LGs")، وأنت تسجّلها في
قيودك باسم آخر ("تأمين كفالة"). فيُسأل المستخدم عن كل مجموعة مرة واحدة،
ويُحفظ جوابه قاعدةً تنطبق على كل كشف قادم.
"""
import re

from odoo import api, fields, models
from odoo.exceptions import UserError

REFERENCE_WORD = re.compile(
    r'\b(?:FT|MD|PD|TT|BDC|CRLC|LOGP|LOGT|AAACT)[A-Z0-9.;]*\d[A-Z0-9.;]*', re.IGNORECASE)
CHEQUE_WORD = re.compile(r'CHQ\.?\s*NO[-\s]*[\d٠-٩]+', re.IGNORECASE)
CHEQUE_RANGE = re.compile(r'Cheque No\s*[\d٠-٩]+\s*to\s*[\d٠-٩]+', re.IGNORECASE)
DIGITS = re.compile(r'[\d٠-٩]+')


def normalize_key(label):
    """مفتاح المجموعة: نصّ الحركة بلا أرقام ولا مراجع."""
    text = REFERENCE_WORD.sub(' ', label or '')
    text = CHEQUE_RANGE.sub(' ', text)
    text = CHEQUE_WORD.sub(' ', text)
    text = DIGITS.sub(' ', text)
    text = re.sub(r'[^\w\s/\'&]', ' ', text)
    return ' '.join(text.split())[:80]


class MyAccountingBankRule(models.Model):
    _name = 'myaccounting.bank.rule'
    _description = 'تعريف حركة بنكية'
    _order = 'name'

    key = fields.Char(string='نصّ البنك', required=True, index=True)
    name = fields.Char(string='ما هي عندك', required=True)
    account_id = fields.Many2one('myaccounting.account', string='الحساب المقابل',
                                 ondelete='set null',
                                 help='الحساب الذي تسجَّل فيه هذه الحركة مقابل حساب البنك.')
    note = fields.Text(string='ملاحظة')

    _key_unique = models.Constraint('unique(key)', 'لكل نصّ بنكي تعريف واحد.')

    @api.model
    def get_rules(self):
        return {rule.key: {
            'id': rule.id,
            'key': rule.key,
            'name': rule.name,
            'account_id': rule.account_id.id or False,
            'account': rule.account_id.name or '',
            'note': rule.note or '',
        } for rule in self.search([])}

    @api.model
    def save_rule(self, key, values):
        key = (key or '').strip()
        if not key:
            raise UserError('لا مفتاح للقاعدة.')
        name = (values.get('name') or '').strip()
        if not name:
            raise UserError('اكتب ما هي هذه الحركة عندك.')
        data = {
            'key': key,
            'name': name,
            'account_id': int(values['account_id']) if values.get('account_id') else False,
            'note': values.get('note') or '',
        }
        rule = self.search([('key', '=', key)], limit=1)
        if rule:
            rule.write(data)
        else:
            self.create(data)
        return self.get_rules()

    @api.model
    def delete_rule(self, rule_id):
        self.browse(int(rule_id)).unlink()
        return self.get_rules()
