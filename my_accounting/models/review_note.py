from odoo import fields, models


class MyAccountingReviewNote(models.Model):
    """حلّ يدوي لملاحظة مراجعة (رقم ناقص في تسلسل الفواتير، رقم مكرر...).

    الملاحظات نفسها تُحسب تلقائياً في كل مرة (انظر myaccounting.customers)، وهذا
    النموذج يحفظ فقط الملاحظات التي حُلَّت مع سبب الحل. المفتاح نصّي ثابت لا يعتمد
    على أرقام السجلات (مثل missing_invoice:279) حتى يبقى صالحاً بعد الاستعادة.
    """
    _name = 'myaccounting.review.note'
    _description = 'حل ملاحظة مراجعة'
    _order = 'resolved_on desc, id desc'

    key = fields.Char(string='المفتاح', required=True, index=True)
    kind = fields.Char(string='النوع')
    title = fields.Char(string='الملاحظة')
    resolution = fields.Text(string='طريقة الحل', required=True)
    resolved_by = fields.Many2one('res.users', string='بواسطة', default=lambda self: self.env.user)
    resolved_on = fields.Datetime(string='التاريخ', default=fields.Datetime.now)

    _key_unique = models.Constraint('UNIQUE(key)', 'هذه الملاحظة محلولة مسبقاً.')
