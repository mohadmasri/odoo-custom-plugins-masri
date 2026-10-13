"""نوع القيد صار يُحسب من اليومية، فنعيد حسابه للقيود القديمة مرة واحدة.

القيود المُدخلة يدوياً بيومية "قبض" كانت تبقى من نوع "قيد"، فلا تُطبع
كسند قبض. هذا السكربت يصحّحها.
"""
from odoo import api, SUPERUSER_ID


def migrate(cr, version):
    env = api.Environment(cr, SUPERUSER_ID, {})
    moves = env['myaccounting.move'].search([])
    if moves:
        moves.invalidate_recordset(['move_type'])
        env.add_to_compute(moves._fields['move_type'], moves)
        env.flush_all()
