"""إعدادات فهرس الطباعة (صفحة أولى تسرد المستندات المطبوعة وأرقام صفحاتها).

تُدار من "إعدادات أخرى ← الفهرس"، وتُقرأ عند بناء تقرير كشف الحساب.
"""
import json

from odoo import api, models

PARAM = 'my_accounting.print_index'

DEFAULTS = {
    # 'ask' يسأل قبل كل طباعة، وإلا يُطبَّق الاختيار مباشرة
    'mode': 'ask',                      # ask | always | never
    'title': 'فهرس كشوف الحسابات',
    'show_seq': True,                   # الرقم التسلسلي
    'show_code': False,                 # رمز الحساب
    'show_name': True,                  # اسم الحساب
    'show_balance': True,               # الرصيد
    'stamp_pages': True,                # طباعة رقم الصفحة على كل كشف
}

MODES = ('ask', 'always', 'never')


class MyAccountingPrintIndex(models.AbstractModel):
    _name = 'myaccounting.print.index'
    _description = 'إعدادات فهرس الطباعة'

    @api.model
    def get_settings(self):
        """الإعدادات المحفوظة مدموجة مع الافتراضية (فلا تنكسر عند إضافة خيار)."""
        raw = self.env['ir.config_parameter'].sudo().get_param(PARAM)
        settings = dict(DEFAULTS)
        if raw:
            try:
                stored = json.loads(raw)
            except ValueError:
                stored = {}
            for key, value in stored.items():
                if key in DEFAULTS:
                    settings[key] = value
        if settings['mode'] not in MODES:
            settings['mode'] = DEFAULTS['mode']
        settings['title'] = (settings['title'] or '').strip() or DEFAULTS['title']
        # لا يجوز أن تخلو أسطر الفهرس من كل شيء
        if not any(settings[key] for key in ('show_seq', 'show_code', 'show_name', 'show_balance')):
            settings['show_name'] = True
        return settings

    @api.model
    def set_settings(self, values):
        settings = self.get_settings()
        for key in DEFAULTS:
            if key in values:
                settings[key] = values[key]
        self.env['ir.config_parameter'].sudo().set_param(PARAM, json.dumps(settings))
        return self.get_settings()
