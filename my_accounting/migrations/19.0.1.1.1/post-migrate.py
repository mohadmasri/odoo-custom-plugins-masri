"""إعادة حساب نوع القيد ثم مفتاح ترتيبه.

مفتاح الترتيب يعتمد على النوع، والترحيل السابق غيّر النوع دون أن يعيد
حساب المفتاح، فظهر سند قبض خارج مكانه في قائمة القيود. نعيد حساب
الاثنين بالترتيب: النوع أولاً ثم المفتاح المبنيّ عليه.
"""
from odoo import api, SUPERUSER_ID


def _recompute(env, moves, field_name):
    moves.invalidate_recordset([field_name])
    env.add_to_compute(moves._fields[field_name], moves)
    env.flush_all()


def migrate(cr, version):
    env = api.Environment(cr, SUPERUSER_ID, {})
    moves = env['myaccounting.move'].search([])
    if not moves:
        return
    _recompute(env, moves, 'move_type')
    _recompute(env, moves, 'sort_key')
