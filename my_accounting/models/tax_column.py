# -*- coding: utf-8 -*-
from odoo import api, fields, models

# أعمدة كل جدول من جداول الإقرار على حدة: المفتاح والاسم المبدئي.
# المفتاح ثابت لأن القالب يبني الخانة عليه؛ الاسم والترتيب وحدهما للمستخدم.
PURCHASE_COLUMNS = [
    ('taxno', 'الرقم الضريبي'),
    ('doc', 'رقم الفاتورة'),
    ('date', 'التاريخ'),
    ('label', 'البيان'),
    ('party', 'لصالح من'),
    ('amount', 'القيمة'),
    ('tax', 'الضريبة'),
    ('move', 'سند القيد'),
]

SALE_COLUMNS = [
    ('doc', 'رقم السند'),
    ('move', 'رقم القبض'),
    ('type', 'نوعه'),
    ('date', 'التاريخ'),
    ('label', 'البيان'),
    ('party', 'لصالح من'),
    ('amount', 'القيمة'),
    ('tax', 'الضريبة'),
]

DEFAULT_COLUMNS = {
    'purchase': PURCHASE_COLUMNS,
    'purchase_return': PURCHASE_COLUMNS,
    'sale': SALE_COLUMNS,
    'sale_return': SALE_COLUMNS,
}


class MyAccountingTaxColumn(models.Model):
    _name = 'myaccounting.tax.column'
    _description = 'عمود في جدول من جداول الإقرار الضريبي'
    _order = 'table, sequence, id'

    table = fields.Char(string='الجدول', required=True, index=True)
    key = fields.Char(string='المفتاح', required=True, index=True)
    label = fields.Char(string='الاسم', required=True)
    sequence = fields.Integer(string='الترتيب', default=10, index=True)

    _sql_constraints = [
        ('table_key_unique', 'unique(table, key)', 'لكل عمود مفتاح واحد في جدوله.'),
    ]

    # ------------------------------------------------------------------
    # القراءة
    # ------------------------------------------------------------------

    @api.model
    def _ensure(self):
        """ينشئ الأعمدة الناقصة بأسمائها المبدئية، ويزيل ما لم يعد له جدول."""
        columns = self.search([])
        stale = columns.filtered(lambda column: column.table not in DEFAULT_COLUMNS)
        if stale:
            columns = columns - stale
            stale.unlink()
        existing = {(column.table, column.key): column for column in columns}
        created = self.browse()
        for table, defaults in DEFAULT_COLUMNS.items():
            for index, (key, label) in enumerate(defaults):
                if (table, key) in existing:
                    continue
                before = defaults[index - 1][0] if index else None
                neighbour = existing.get((table, before)) if before else None
                sequence = (neighbour.sequence + 5) if neighbour else (index + 1) * 10
                column = self.create({
                    'table': table, 'key': key, 'label': label,
                    'sequence': sequence,
                })
                existing[(table, key)] = column
                created |= column
        return columns | created

    @api.model
    def get_columns(self):
        """أعمدة كل جدول بترتيبه: {مفتاح الجدول: [أعمدة]}."""
        result = {table: [] for table in DEFAULT_COLUMNS}
        for column in self._ensure().sorted(lambda c: (c.sequence, c.id)):
            if column.table not in result:
                continue
            defaults = dict(DEFAULT_COLUMNS[column.table])
            result[column.table].append({
                'id': column.id,
                'key': column.key,
                'label': column.label or defaults.get(column.key, column.key),
                'default_label': defaults.get(column.key, column.key),
            })
        return result

    # ------------------------------------------------------------------
    # الكتابة
    # ------------------------------------------------------------------

    @api.model
    def set_columns(self, table, items):
        """يحفظ أسماء أعمدة جدول واحد وترتيبها. items: [{key, label}, ...]."""
        if table not in DEFAULT_COLUMNS:
            return self.get_columns()
        by_key = {column.key: column
                  for column in self._ensure().filtered(lambda c: c.table == table)}
        defaults = dict(DEFAULT_COLUMNS[table])
        for index, item in enumerate(items or []):
            column = by_key.get(item.get('key'))
            if not column:
                continue
            label = (item.get('label') or '').strip() or defaults.get(column.key, column.key)
            column.write({'label': label, 'sequence': (index + 1) * 10})
        return self.get_columns()

    @api.model
    def reset_columns(self, table=None):
        """يعيد جدولاً واحداً — أو كل الجداول — إلى أسمائه وترتيبه الأصلي."""
        tables = [table] if table in DEFAULT_COLUMNS else list(DEFAULT_COLUMNS)
        columns = self._ensure()
        for name in tables:
            by_key = {column.key: column
                      for column in columns.filtered(lambda c: c.table == name)}
            for index, (key, label) in enumerate(DEFAULT_COLUMNS[name]):
                column = by_key.get(key)
                if column:
                    column.write({'label': label, 'sequence': (index + 1) * 10})
        return self.get_columns()
