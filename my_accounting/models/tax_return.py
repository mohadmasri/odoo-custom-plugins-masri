"""الإقرار الضريبي: يجمع ضريبة المبيعات من القيود عن فترة مختارة.

الحساب كله مبنيّ على قيودك كما هي: كل بند على حساب الضريبة يُنسب إلى
مجموعته (نفس القيد ونفس البيان) ليُعرف هل هو ضريبة على مبيعات، أم مرتجع
مبيعات، أم ضريبة مدخلات على مشتريات، أم تسديد إقرار سابق لا يخصّ الفترة.
"""
import re

from odoo import api, fields, models

# بند الضريبة الذي نصّه يذكر "إقرار" هو تسديد إقرار سابق، لا ضريبة مدخلات
SETTLEMENT_RE = re.compile(r'[اأإ]قرار')

MONTH_NAMES = [
    '', 'كانون الثاني', 'شباط', 'آذار', 'نيسان', 'أيار', 'حزيران',
    'تموز', 'آب', 'أيلول', 'تشرين الأول', 'تشرين الثاني', 'كانون الأول',
]


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
    def _period_moves(self, year, month_from, month_to):
        months = [str(month) for month in range(int(month_from), int(month_to) + 1)]
        return self.env['myaccounting.move'].search([
            ('ledger_year', '=', int(year)),
            ('ledger_month', 'in', months),
        ], order='sort_key, id')

    @api.model
    def get_return(self, year, month_from, month_to):
        settings = self._settings()
        tax_account = settings['tax_account']
        income_account = settings['income_account']
        rate = settings['rate']
        moves = self._period_moves(year, month_from, month_to)
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
                'إن كان القانون يوجب توزيع ضريبة المدخلات على الخاضع والمعفى، '
                f'فالمخصوم يصير نحو {total_input * share / 100:,.3f} بدل {total_input:,.3f}.')

        return {
            'period': {
                'year': int(year),
                'month_from': int(month_from),
                'month_to': int(month_to),
                'label': self._period_label(year, month_from, month_to),
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
    def _period_label(self, year, month_from, month_to):
        first, last = int(month_from), int(month_to)
        if first == last:
            return f'{MONTH_NAMES[first]} {year}'
        return f'{MONTH_NAMES[first]} + {MONTH_NAMES[last]} {year}' if last - first == 1 \
            else f'{MONTH_NAMES[first]} حتى {MONTH_NAMES[last]} {year}'
