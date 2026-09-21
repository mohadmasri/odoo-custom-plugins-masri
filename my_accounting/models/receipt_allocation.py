from odoo import fields, models


class MyAccountingReceiptAllocation(models.Model):
    """تخصيص (جزء من) سند قبض لفاتورة عميل محددة.

    الفاتورة تُعرَّف برقمها + حساب العميل (وليس ببند القيد) لأن رقم الفاتورة ثابت
    ومكتوب في البيان، بينما أرقام البنود تتغير عند الاستعادة أو إعادة الإدخال.
    السندات بلا تخصيص تُوزَّع تلقائياً على أقدم الفواتير (انظر myaccounting.customers).
    """
    _name = 'myaccounting.receipt.allocation'
    _description = 'تخصيص سند قبض لفاتورة'
    _order = 'receipt_move_id, invoice_number'

    receipt_move_id = fields.Many2one('myaccounting.move', string='سند القبض', required=True,
                                      ondelete='cascade', index=True)
    customer_id = fields.Many2one('myaccounting.account', string='العميل', required=True,
                                  ondelete='cascade', index=True)
    invoice_number = fields.Integer(string='رقم الفاتورة', required=True)
    amount = fields.Float(string='المبلغ', required=True, digits=(16, 3))
