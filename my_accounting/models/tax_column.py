# -*- coding: utf-8 -*-
from odoo import api, fields, models

# أعمدة جداول الإقرار: المفتاح، الاسم المبدئي، وأين يظهر العمود.
# المفتاح ثابت لأن القالب يبني الخانة عليه؛ الاسم والترتيب وحدهما للمستخدم.
DEFAULT_COLUMNS = [
    ('taxno', 'الرقم الضريبي', 'purchase'),
    ('doc_purchase', 'رقم الفاتورة', 'purchase'),
    ('doc_sale', 'رقم السند', 'sale'),
    ('type', 'نوعه', 'sale'),
    ('date', 'التاريخ', 'both'),
    ('label', 'البيان', 'both'),
    ('party', 'لصالح من', 'both'),
    ('amount', 'القيمة', 'both'),
    ('tax', 'الضريبة', 'both'),
    ('move', 'سند القيد', 'purchase'),
]

SCOPE_LABELS = {
    'both': '',
    'purchase': 'المشتريات فقط',
    'sale': 'المبيعات فقط',
}


class MyAccountingTaxColumn(models.Model):
    _name = 'myaccounting.tax.column'
    _description = 'عمود في جداول الإقرار الضريبي'
    _order = 'sequence, id'

    key = fields.Char(string='المفتاح', required=True, index=True)
    label = fields.Char(string='الاسم', required=True)
    sequence = fields.Integer(string='الترتيب', default=10, index=True)

    _sql_constraints = [
        ('key_unique', 'unique(key)', 'لكل عمود مفتاح واحد.'),
    ]

    # ------------------------------------------------------------------
    # القراءة
    # ------------------------------------------------------------------

    @api.model
    def _ensure(self):
        """ينشئ الأعمدة الناقصة بأسمائها وترتيبها المبدئي."""
        existing = {column.key: column for column in self.search([])}
        for index, (key, label, _scope) in enumerate(DEFAULT_COLUMNS):
            if key not in existing:
                existing[key] = self.create({
                    'key': key, 'label': label, 'sequence': (index + 1) * 10,
                })
        return self.search([])

    @api.model
    def get_columns(self):
        scopes = {key: scope for key, _label, scope in DEFAULT_COLUMNS}
        defaults = {key: label for key, label, _scope in DEFAULT_COLUMNS}
        columns = []
        for column in self._ensure():
            if column.key not in scopes:
                continue
            columns.append({
                'id': column.id,
                'key': column.key,
                'label': column.label or defaults[column.key],
                'scope': scopes[column.key],
                'scope_label': SCOPE_LABELS[scopes[column.key]],
                'default_label': defaults[column.key],
            })
        return columns

    # ------------------------------------------------------------------
    # الكتابة
    # ------------------------------------------------------------------

    @api.model
    def set_columns(self, items):
        """يحفظ الأسماء والترتيب معاً. items: [{key, label}, ...] بالترتيب."""
        by_key = {column.key: column for column in self._ensure()}
        defaults = {key: label for key, label, _scope in DEFAULT_COLUMNS}
        for index, item in enumerate(items or []):
            column = by_key.get(item.get('key'))
            if not column:
                continue
            label = (item.get('label') or '').strip() or defaults[column.key]
            column.write({'label': label, 'sequence': (index + 1) * 10})
        return self.get_columns()

    @api.model
    def reset_columns(self):
        by_key = {column.key: column for column in self._ensure()}
        for index, (key, label, _scope) in enumerate(DEFAULT_COLUMNS):
            column = by_key.get(key)
            if column:
                column.write({'label': label, 'sequence': (index + 1) * 10})
        return self.get_columns()
