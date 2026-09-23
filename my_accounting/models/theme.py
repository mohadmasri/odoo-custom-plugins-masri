"""مظهر الواجهة: الوضع (فاتح/داكن) ولون الواجهة، لكل مستخدم على حدة.

الوضع الداكن يعتمد على كوكي color_scheme (انظر ir_http.py وزر الشريط العلوي)،
أما اللون فيُحفظ هنا ويُطبَّق فوراً بمتغيّرات CSS دون إعادة تحميل.
"""
from odoo import api, models

THEME_PARAM = 'my_accounting.ui_theme'
DEFAULT_THEME = 'odoo'
THEMES = [
    {'key': 'odoo', 'name': 'أرجواني (افتراضي)', 'colors': ['#714B67', '#8F5F86']},
    {'key': 'ocean', 'name': 'أزرق محيطي', 'colors': ['#1B3B6F', '#2E86DE']},
    {'key': 'emerald', 'name': 'أخضر زمردي', 'colors': ['#0B6B4F', '#28A745']},
    {'key': 'sunset', 'name': 'برتقالي غروب', 'colors': ['#B54708', '#E67E22']},
    {'key': 'midnight', 'name': 'ليلي نيون', 'colors': ['#0F1633', '#6C5CE7']},
    {'key': 'graphite', 'name': 'رمادي هادئ', 'colors': ['#3C4650', '#6C757D']},
]


class MyAccountingTheme(models.AbstractModel):
    _name = 'myaccounting.theme'
    _description = 'مظهر واجهة المحاسبة'

    def _theme_param(self):
        return f'{THEME_PARAM}.{self.env.uid}'

    @api.model
    def get_theme(self):
        theme = self.env['ir.config_parameter'].sudo().get_param(self._theme_param()) or DEFAULT_THEME
        if theme not in [item['key'] for item in THEMES]:
            theme = DEFAULT_THEME
        return {'theme': theme, 'themes': THEMES}

    @api.model
    def set_theme(self, theme):
        if theme not in [item['key'] for item in THEMES]:
            theme = DEFAULT_THEME
        self.env['ir.config_parameter'].sudo().set_param(self._theme_param(), theme)
        return theme
