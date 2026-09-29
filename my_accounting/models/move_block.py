"""الكتل الجاهزة: صف واحد من البيانات يولّد بنود القيد المتكررة.

قيود المكتب مبنية من كتل ثابتة تتكرر: الفاتورة ثلاثة بنود (ذمم / إيراد /
ضريبة)، والكفالة ثلاثة (كفالات / عمولة / بنك)، وسند القبض ثلاثة (ذمم /
بنك بالصافي / طوابع). هذا النموذج يحفظ الحسابات المعتادة لكل كتلة ونسبة
الضريبة، فلا يُعاد اختيارها في كل مرة.
"""
import json

from odoo import api, models

PARAM = 'my_accounting.move_blocks'

# الحساب المعتاد لكل خانة، يُبحث عنه برمزه أول مرة ثم يُحفظ اختيار المستخدم
DEFAULT_CODES = {
    'income_account_id': '401',       # الايرادات
    'tax_account_id': '201',          # ضريبة المبيعات
    'guarantee_account_id': '652',    # تامين كفالات
    'commission_account_id': '760',   # م كفالات / ادارية
    'guarantee_bank_id': '101',       # الاهلي
    'receipt_bank_id': '101',         # الاهلي
    'receipt_fee_account_id': '',     # الطوابع تختلف بحسب المشروع
}

DEFAULT_TAX_RATE = 16.0


class MyAccountingMoveBlock(models.AbstractModel):
    _name = 'myaccounting.move.block'
    _description = 'الكتل الجاهزة لبنود القيد'

    @api.model
    def _stored(self):
        raw = self.env['ir.config_parameter'].sudo().get_param(PARAM)
        if not raw:
            return {}
        try:
            stored = json.loads(raw)
        except ValueError:
            return {}
        return stored if isinstance(stored, dict) else {}

    @api.model
    def get_setup(self):
        """شجرة الحسابات + الحسابات المعتادة لكل كتلة + نسبة الضريبة."""
        accounts = self.env['myaccounting.account'].search([], order='code_path')
        stored = self._stored()
        settings = {}
        alive = set(accounts.ids)
        for key, code in DEFAULT_CODES.items():
            value = stored.get(key)
            # الحساب المحفوظ قد يكون حُذف من الشجرة، فنعود إلى الرمز المعتاد
            if not (isinstance(value, int) and value in alive):
                value = False
                if code:
                    match = accounts.filtered(lambda acc: acc.code == code)[:1]
                    value = match.id if match else False
            settings[key] = value
        rate = stored.get('tax_rate')
        settings['tax_rate'] = rate if isinstance(rate, (int, float)) else DEFAULT_TAX_RATE
        return {
            'accounts': [{'id': acc.id, 'code': acc.code or '', 'name': acc.name,
                          'label': f'{acc.code} - {acc.name}' if acc.code else acc.name}
                         for acc in accounts],
            'settings': settings,
        }

    @api.model
    def remember(self, values):
        """يحفظ ما اختاره المستخدم في الكتلة ليأتي جاهزاً في المرة القادمة."""
        stored = self._stored()
        for key in DEFAULT_CODES:
            if key in values:
                stored[key] = values[key] or False
        if 'tax_rate' in values:
            try:
                stored['tax_rate'] = float(values['tax_rate'])
            except (TypeError, ValueError):
                pass
        self.env['ir.config_parameter'].sudo().set_param(PARAM, json.dumps(stored))
        return True
