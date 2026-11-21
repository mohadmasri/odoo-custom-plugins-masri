"""صفحة البداية: المستخدم يقع على صفحة التطبيقات لا على المناقشة.

أودو بلا «صفحة بداية» محدّدة يفتح أول قائمةٍ يراها المستخدم، وقد تكون
المناقشة أو غيرها بحسب صلاحياته. فنجعل البداية لكل مستخدمٍ صفحةَ
التطبيقات الفعّالة، ومنها يختار ما يشاء.
"""
from odoo import api, fields, models

HOME_ACTION = 'my_accounting.action_app_launcher'


class ResUsers(models.Model):
    _inherit = 'res.users'

    @api.model
    def _myaccounting_home_action(self):
        return self.env.ref(HOME_ACTION, raise_if_not_found=False)

    # صفحة البداية لكل مستخدمٍ جديد
    action_id = fields.Many2one(
        default=lambda self: self._myaccounting_home_action())

    @api.model
    def _set_home_to_app_launcher(self):
        """يضع صفحة التطبيقات بدايةً لمن لا بداية له (يُستدعى عند التثبيت)."""
        action = self._myaccounting_home_action()
        if not action:
            return 0
        users = self.with_context(active_test=False).search(
            [('share', '=', False), ('action_id', '=', False)])
        users.write({'action_id': action.id})
        return len(users)
