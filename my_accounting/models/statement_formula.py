# -*- coding: utf-8 -*-
"""بنود الميزانية المحسوبة: معادلات على الحسابات والأبواب وبنود أخرى.

المعادلة يكتبها المستخدم، فلا تُنفَّذ كشيفرة: يقرأها محلّل صغير يعرف
الأرقام والأقواس والعمليات الأربع والمراجع وحدها، كما في صيغ الكتل الجاهزة.

المراجع:
    [121]      رصيد الحساب برمزه ومعه فروعه
    {الأصول}   مجموع باب
    <صافي ...> بند محسوب آخر
"""
import re

from odoo import api, fields, models
from odoo.exceptions import UserError

TOKEN_RE = re.compile(r"""
    \s*(?:
        (?P<number>\d+(?:\.\d+)?)
      | \[(?P<account>[^\]]*)\]
      | \{(?P<group>[^\}]*)\}
      | <(?P<line>[^>]*)>
      | (?P<op>[+\-*/()])
    )
""", re.VERBOSE)

PLACEMENTS = [
    ('group', 'تحت باب'),
    ('side', 'آخر جانب'),
    ('bottom', 'جدول المؤشرات'),
]

SIDES = [('debit', 'جانب الأصول'), ('credit', 'جانب الخصوم')]


class FormulaError(Exception):
    pass


def tokenize(formula):
    tokens = []
    position = 0
    text = formula or ''
    while position < len(text):
        match = TOKEN_RE.match(text, position)
        if not match:
            rest = text[position:].strip()
            if not rest:
                break
            raise FormulaError('لا أفهم "%s"' % rest[:12])
        position = match.end()
        for kind in ('number', 'account', 'group', 'line', 'op'):
            value = match.group(kind)
            if value is not None:
                tokens.append((kind, value.strip()))
                break
    return tokens


class Parser:
    """محلّل نزولي بسيط: جمع وطرح، ثم ضرب وقسمة، ثم الوحدات."""

    def __init__(self, tokens, resolve):
        self.tokens = tokens
        self.index = 0
        self.resolve = resolve

    def peek(self):
        return self.tokens[self.index] if self.index < len(self.tokens) else (None, None)

    def take(self):
        token = self.peek()
        self.index += 1
        return token

    def parse(self):
        value = self.sum()
        if self.index != len(self.tokens):
            raise FormulaError('زيادة في آخر المعادلة')
        return value

    def sum(self):
        value = self.product()
        while self.peek() == ('op', '+') or self.peek() == ('op', '-'):
            operator = self.take()[1]
            other = self.product()
            value = value + other if operator == '+' else value - other
        return value

    def product(self):
        value = self.unit()
        while self.peek() == ('op', '*') or self.peek() == ('op', '/'):
            operator = self.take()[1]
            other = self.unit()
            if operator == '*':
                value *= other
            else:
                if not other:
                    raise FormulaError('قسمة على صفر')
                value /= other
        return value

    def unit(self):
        kind, value = self.take()
        if kind == 'op' and value == '-':
            return -self.unit()
        if kind == 'op' and value == '+':
            return self.unit()
        if kind == 'op' and value == '(':
            inner = self.sum()
            if self.take() != ('op', ')'):
                raise FormulaError('قوس ناقص')
            return inner
        if kind == 'number':
            return float(value)
        if kind in ('account', 'group', 'line'):
            return self.resolve(kind, value)
        raise FormulaError('المعادلة ناقصة')


def evaluate(formula, resolve):
    tokens = tokenize(formula)
    if not tokens:
        raise FormulaError('المعادلة فارغة')
    return Parser(tokens, resolve).parse()


class MyAccountingStatementLine(models.Model):
    _name = 'myaccounting.statement.line'
    _description = 'بند محسوب في الميزانية'
    _order = 'sequence, id'

    name = fields.Char(string='الاسم', required=True)
    formula = fields.Char(string='المعادلة', required=True, default='0')
    sequence = fields.Integer(string='الترتيب', default=50)
    placement = fields.Selection(PLACEMENTS, string='الموضع', required=True, default='bottom')
    group_id = fields.Many2one('myaccounting.statement.group', string='الباب',
                               ondelete='cascade')
    side = fields.Selection(SIDES, string='الجانب', default='debit')
    bold = fields.Boolean(string='إبراز')

    @api.model
    def get_lines(self):
        return [{
            'id': line.id,
            'name': line.name or '',
            'formula': line.formula or '',
            'sequence': line.sequence,
            'placement': line.placement,
            'group_id': line.group_id.id or False,
            'side': line.side or 'debit',
            'bold': line.bold,
        } for line in self.search([])]

    @api.model
    def save_line(self, line_id, values):
        allowed = ('name', 'formula', 'sequence', 'placement', 'group_id', 'side', 'bold')
        data = {key: values[key] for key in allowed if key in values}
        if 'name' in data:
            data['name'] = (data['name'] or '').strip()
            if not data['name']:
                raise UserError('لا بدّ للبند من اسم.')
        if 'group_id' in data:
            data['group_id'] = int(data['group_id']) if data['group_id'] else False
        if 'sequence' in data:
            data['sequence'] = int(data['sequence'] or 0)
        if line_id:
            self.browse(int(line_id)).write(data)
        else:
            self.create(data)
        return self.get_lines()

    @api.model
    def save_lines(self, items):
        """يحفظ لوحة البنود كاملة: ما حُذف يُحذف، وما استجدّ يُنشأ."""
        existing = {line.id: line for line in self.search([])}
        kept = set()
        for item in items or []:
            name = (item.get('name') or '').strip()
            if not name:
                raise UserError('لا بدّ للبند من اسم.')
            data = {
                'name': name,
                'formula': (item.get('formula') or '0').strip() or '0',
                'sequence': int(item.get('sequence') or 0),
                'placement': item.get('placement') or 'bottom',
                'group_id': int(item['group_id']) if item.get('group_id') else False,
                'side': item.get('side') or 'debit',
                'bold': bool(item.get('bold')),
            }
            line = existing.get(item.get('id'))
            if line:
                line.write(data)
                kept.add(line.id)
            else:
                kept.add(self.create(data).id)
        gone = self.browse([key for key in existing if key not in kept])
        if gone:
            gone.unlink()
        return self.get_lines()

    @api.model
    def delete_line(self, line_id):
        self.browse(int(line_id)).unlink()
        return self.get_lines()

    # ------------------------------------------------------------------
    # الحساب
    # ------------------------------------------------------------------

    @api.model
    def compute_lines(self, account_values, group_values):
        """يحسب كل البنود. account_values بالرمز، group_values باسم الباب."""
        lines = self.search([])
        by_name = {line.name.strip(): line for line in lines if line.name}
        results = {}
        errors = {}
        stack = []

        def value_of(line):
            key = line.name.strip()
            if key in results:
                return results[key]
            if key in stack:
                raise FormulaError('البند يشير إلى نفسه')
            stack.append(key)
            try:
                number = evaluate(line.formula, make_resolver())
                results[key] = number
                return number
            finally:
                stack.pop()

        def make_resolver():
            def resolve(kind, name):
                if kind == 'account':
                    if name not in account_values:
                        raise FormulaError('لا حساب برمز %s' % name)
                    return account_values[name]
                if kind == 'group':
                    if name not in group_values:
                        raise FormulaError('لا باب اسمه %s' % name)
                    return group_values[name]
                target = by_name.get(name)
                if not target:
                    raise FormulaError('لا بند اسمه %s' % name)
                return value_of(target)
            return resolve

        payload = []
        for line in lines:
            try:
                number = value_of(line)
                payload.append({
                    'id': line.id, 'name': line.name, 'bold': line.bold,
                    'placement': line.placement, 'group_id': line.group_id.id or False,
                    'side': line.side or 'debit',
                    'value': round(number, 3), 'error': '',
                })
            except FormulaError as error:
                errors[line.id] = str(error)
                payload.append({
                    'id': line.id, 'name': line.name, 'bold': line.bold,
                    'placement': line.placement, 'group_id': line.group_id.id or False,
                    'side': line.side or 'debit',
                    'value': 0.0, 'error': str(error),
                })
            except RecursionError:
                payload.append({
                    'id': line.id, 'name': line.name, 'bold': line.bold,
                    'placement': line.placement, 'group_id': line.group_id.id or False,
                    'side': line.side or 'debit',
                    'value': 0.0, 'error': 'حلقة بين البنود',
                })
        return payload
