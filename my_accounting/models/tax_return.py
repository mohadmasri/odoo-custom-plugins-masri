"""الإقرار الضريبي: يجمع ضريبة المبيعات من القيود عن فترة مختارة.

الحساب كله مبنيّ على قيودك كما هي: كل بند على حساب الضريبة يُنسب إلى
مجموعته (نفس القيد ونفس البيان) ليُعرف هل هو ضريبة على مبيعات، أم مرتجع
مبيعات، أم ضريبة على مشتريات، أم تسديد إقرار سابق لا يخصّ الفترة.
"""
import re

from odoo import api, fields, models

# بند الضريبة الذي نصّه يذكر "إقرار" هو تسديد إقرار سابق، لا ضريبة مشتريات
SETTLEMENT_RE = re.compile(r'[اأإ]قرار')

_MONTH_NAMES = [
    '', 'كانون الثاني', 'شباط', 'آذار', 'نيسان', 'أيار', 'حزيران',
    'تموز', 'آب', 'أيلول', 'تشرين الأول', 'تشرين الثاني', 'كانون الأول',
]
# كل تاريخٍ يُكتب برقم شهره قبل اسمه: «4 - نيسان»
MONTH_NAMES = ['' if not index else '%d - %s' % (index, name)
               for index, name in enumerate(_MONTH_NAMES)]


class MyAccountingTaxReturn(models.AbstractModel):
    _name = 'myaccounting.tax.return'
    _description = 'الإقرار الضريبي'

    @api.model
    def _settings(self):
        """حسابا الضريبة والإيرادات ونسبة الضريبة، من إعدادات الكتل الجاهزة."""
        block = self.env['myaccounting.move.block'].get_setup()['settings']
        return {
            'tax_account': self.env['myaccounting.account'].browse(
                block['tax_account_id']) if block['tax_account_id'] else self.env['myaccounting.account'],
            'income_account': self.env['myaccounting.account'].browse(
                block['income_account_id']) if block['income_account_id'] else self.env['myaccounting.account'],
            'rate': block['tax_rate'] or 16.0,
        }

    @api.model
    def _period_keys(self, year_from, month_from, year_to, month_to):
        """كل (سنة، شهر) داخل الفترة، ولو عبرت نهاية السنة (12 ثم 1)."""
        start = int(year_from) * 12 + int(month_from) - 1
        end = int(year_to) * 12 + int(month_to) - 1
        if end < start:
            start, end = end, start
        return [(key // 12, key % 12 + 1) for key in range(start, end + 1)]

    @api.model
    def _period_moves(self, year_from, month_from, year_to, month_to):
        keys = set(self._period_keys(year_from, month_from, year_to, month_to))
        moves = self.env['myaccounting.move'].search([
            ('ledger_year', 'in', sorted({year for year, _month in keys})),
            ('ledger_month', '!=', False),
        ], order='sort_key, id')
        return moves.filtered(
            lambda move: (move.ledger_year, int(move.ledger_month)) in keys)

    @api.model
    def get_return(self, year_from, month_from, year_to, month_to):
        """الإقرار عن الفترة من (سنة، شهر) إلى (سنة، شهر)، ولو عبرت السنة."""
        year_to, month_to = int(year_to), int(month_to)
        settings = self._settings()
        tax_account = settings['tax_account']
        income_account = settings['income_account']
        rate = settings['rate']
        moves = self._period_moves(year_from, month_from, year_to, month_to)
        posted = moves.filtered(lambda move: move.state == 'posted')

        sales, sale_returns, exempt, inputs, excluded = [], [], [], [], []
        for move in posted:
            # المجموعة: بنود القيد التي تحمل البيان نفسه (الفاتورة الواحدة)
            groups = {}
            for line in move.line_ids:
                groups.setdefault((line.name or '').strip(), []).append(line)
            for label, lines in groups.items():
                tax = sum(line.credit - line.debit
                          for line in lines if line.account_id == tax_account)
                income = sum(line.credit - line.debit
                             for line in lines if line.account_id == income_account)
                other_debit = sum(line.debit for line in lines
                                  if line.account_id not in (tax_account | income_account))
                has_tax_line = any(line.account_id == tax_account for line in lines)
                row = {
                    'move': move.name or '',
                    'move_id': move.id,
                    'date': move.date and fields.Date.to_string(move.date) or '',
                    'label': label or '—',
                }
                if income > 0:  # مبيعات
                    row.update({'base': income, 'tax': tax})
                    (sales if tax else exempt).append(row)
                elif income < 0:  # مرتجع مبيعات
                    row.update({'base': -income, 'tax': -tax})
                    if tax:
                        sale_returns.append(row)
                    else:
                        row['base'] = -row['base']  # المعفى يُعرض بالسالب
                        exempt.append(row)
                elif has_tax_line and tax < 0:  # الجانب المدين لحساب الضريبة
                    amount = -tax
                    if SETTLEMENT_RE.search(label) or SETTLEMENT_RE.search(move.ref or ''):
                        row.update({'base': 0.0, 'tax': amount,
                                    'reason': 'تسديد إقرار سابق، لا يخصّ هذه الفترة'})
                        excluded.append(row)
                    else:
                        # الأساس من بنود المجموعة نفسها، وإلا يُقدَّر من النسبة
                        estimated = not other_debit
                        row.update({
                            'base': other_debit or (amount / (rate / 100.0) if rate else 0.0),
                            'tax': amount,
                            'estimated': estimated,
                        })
                        inputs.append(row)

        total_output = sum(row['tax'] for row in sales)
        total_returns = sum(row['tax'] for row in sale_returns)
        total_input = sum(row['tax'] for row in inputs)
        net_output = total_output - total_returns
        taxable_base = sum(row['base'] for row in sales) - sum(row['base'] for row in sale_returns)
        exempt_base = sum(row['base'] for row in exempt)

        warnings = []
        draft = moves - posted
        if draft:
            warnings.append(
                f'{len(draft)} قيد في الفترة غير مرحّل، فلم يدخل الحساب: '
                + '، '.join(draft.mapped('name')[:6]))
        if not tax_account:
            warnings.append('لم يُحدَّد حساب ضريبة المبيعات في إعدادات الكتل الجاهزة.')
        if exempt_base and total_input:
            share = taxable_base / (taxable_base + exempt_base) * 100 if (taxable_base + exempt_base) else 0
            warnings.append(
                f'في الفترة مبيعات معفاة ({exempt_base:,.3f})، والخاضع منها {share:,.1f}% فقط. '
                'إن كان القانون يوجب توزيع ضريبة المشتريات على الخاضع والمعفى، '
                f'فالمخصوم يصير نحو {total_input * share / 100:,.3f} بدل {total_input:,.3f}.')

        return {
            'period': {
                'year_from': int(year_from),
                'month_from': int(month_from),
                'year_to': year_to,
                'month_to': month_to,
                'label': self._period_label(year_from, month_from, year_to, month_to),
            },
            'rate': rate,
            'tax_account': tax_account.name or '',
            'income_account': income_account.name or '',
            'sales': sales,
            'sale_returns': sale_returns,
            'exempt': exempt,
            'inputs': inputs,
            'excluded': excluded,
            'totals': {
                'taxable_base': taxable_base,
                'exempt_base': exempt_base,
                'output': total_output,
                'returns': total_returns,
                'net_output': net_output,
                'input': total_input,
                'due': net_output - total_input,
            },
            'moves': len(posted),
            'warnings': warnings,
        }

    @api.model
    def _period_label(self, year_from, month_from, year_to, month_to):
        keys = self._period_keys(year_from, month_from, year_to, month_to)
        (first_year, first_month), (last_year, last_month) = keys[0], keys[-1]
        first = f'{MONTH_NAMES[first_month]} {first_year}'
        last = f'{MONTH_NAMES[last_month]} {last_year}'
        if len(keys) == 1:
            return first
        if len(keys) == 2:
            # شهران من سنة واحدة: تُذكر السنة مرة واحدة
            return (f'{MONTH_NAMES[first_month]} + {last}' if first_year == last_year
                    else f'{first} + {last}')
        return f'{first} حتى {last}'
