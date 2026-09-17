from odoo import models
from odoo.http import request


class IrHttp(models.AbstractModel):
    _inherit = 'ir.http'

    def color_scheme(self):
        # يفعّل الوضع الداكن المبني أصلاً في أودو (حزمة web.assets_web_dark)
        # بالاعتماد على كوكي "color_scheme" التي يضبطها زر التبديل في الشريط
        # العلوي، بدل الاعتماد الافتراضي دائماً على الوضع الفاتح.
        if request and request.httprequest.cookies.get('color_scheme') == 'dark':
            return 'dark'
        return super().color_scheme()
