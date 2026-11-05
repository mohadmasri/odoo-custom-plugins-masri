# -*- coding: utf-8 -*-
"""كشف رواتب مرفوع: ملفٌ يُقرأ ويُحفظ كما هو، وتُنشأ منه القيود.

لا بطاقات ولا تعديل على كشوف الموظفين: الملف يُقرأ صفوفاً، فتُعرض
جداوله كما تُعرض كشوف الشهر، ويُحفظ ليُرجع إليه. ومنه تُنشأ قيود
الرواتب بترتيب قيوده ولفظها، فتُقيَّد رواتب شهرٍ ماضٍ أو قادم بلا
مساسٍ بالبطاقات ولا بكشوف الأشهر.
"""
from odoo import api, fields, models
from odoo.exceptions import UserError

from .payroll import MONTH_NAMES, MONTHS, sheet_entries


class MyAccountingPayrollUpload(models.Model):
    _name = 'myaccounting.payroll.upload'
    _description = 'كشف رواتب مرفوع'
    _order = 'year desc, month desc, id desc'

    name = fields.Char(string='الكشف', required=True)
    filename = fields.Char(string='الملف')
    year = fields.Integer(string='السنة', required=True)
    month = fields.Selection(MONTHS, string='الشهر', required=True)
    line_ids = fields.One2many('myaccounting.payroll.upload.line', 'upload_id',
                               string='البنود')

    # ------------------------------------------------------------------
    # الكشوف المرفوعة
    # ------------------------------------------------------------------

    def _payload(self):
        self.ensure_one()
        lines = [line._payload() for line in self.line_ids]
        return {
            'id': self.id,
            'name': self.name,
            'filename': self.filename or '',
            'year': self.year,
            'month': self.month,
            'month_label': MONTH_NAMES.get(self.month, ''),
            'lines': lines,
            'sheets': self._sheets_payload(),
        }

    def _sheets(self):
        """كشوف هذا الملف بترتيب كشوف النظام، وما لا كشف له في آخرها."""
        self.ensure_one()
        groups = self.line_ids.group_id.sorted(
            lambda group: (group.sequence, group.id))
        sheets = [(str(group.id), group, group.name) for group in groups]
        for line in self.line_ids:
            if line.group_id:
                continue
            key = 'x%s' % line.sheet
            if key not in [item[0] for item in sheets]:
                sheets.append((key, self.env['myaccounting.payroll.group'],
                               line.sheet or 'بلا كشف'))
        return sheets

    def _sheet_lines(self, sheet):
        self.ensure_one()
        key = str(sheet)
        if key.startswith('x'):
            name = key[1:]
            return self.line_ids.filtered(
                lambda line: not line.group_id and (line.sheet or '') == name)
        return self.line_ids.filtered(lambda line: line.group_id.id == int(key))

    def _sheets_payload(self):
        self.ensure_one()
        return [{
            'key': key,
            'name': label,
            'group_id': group.id or False,
            'count': len(self._sheet_lines(key)),
            'account': (group.account_id.name
                        or 'حساب الرواتب العام') if group else '—',
        } for key, group, label in self._sheets()]

    @api.model
    def get_uploads(self):
        return [{
            'id': upload.id,
            'name': upload.name,
            'year': upload.year,
            'month': upload.month,
            'lines': len(upload.line_ids),
        } for upload in self.search([], limit=60)]

    @api.model
    def get_upload(self, upload_id=False):
        upload = (self.browse(int(upload_id)) if upload_id
                  else self.search([], limit=1))
        return upload._payload() if upload.exists() else False

    # ------------------------------------------------------------------
    # الرفع
    # ------------------------------------------------------------------

    @api.model
    def read_excel(self, content, filename=False, year=False, month=False):
        """يقرأ الملف ويحفظه كشفاً مرفوعاً، بلا مساسٍ بالبطاقات."""
        Employee = self.env['myaccounting.employee']
        rows, skipped = Employee._excel_rows(content)
        settings = self.env['myaccounting.payroll.settings']._get()
        rate = settings.employee_rate or 0.0
        groups = {group.name.strip(): group
                  for group in self.env['myaccounting.payroll.group'].search([])}
        today = fields.Date.context_today(self)
        year = int(year or today.year)
        month = str(month or today.month)
        upload = self.create({
            'name': 'كشف مرفوع %s/%s' % (month, year),
            'filename': filename or '',
            'year': year,
            'month': month,
        })
        Line = self.env['myaccounting.payroll.upload.line']
        for index, row in enumerate(rows):
            group = groups.get(row['sheet'].strip())
            social = row['social']
            Line.create({
                'upload_id': upload.id,
                'sequence': index * 10,
                'sheet': row['sheet'],
                'group_id': group.id if group else False,
                'employee': row['name'],
                'basic_salary': row['basic_salary'],
                'allowance': row['allowance'],
                # الخاضع للضمان يُستنتج من المقتطع، فتخرج حصة الشركة صحيحة
                'social_base': round(social * 100.0 / rate, 3) if social and rate else 0.0,
                'employee_social': social,
                'income_tax': row['income_tax'],
                'pension': row['pension'],
                'payment_method': 'cheque' if row['cheque'] else 'transfer',
                'account_id': group.account_id.id if group else False,
                'payment_account_id': (group.payment_account_id.id
                                       if group else False),
            })
        upload = upload.with_context(skipped=skipped)
        return upload._payload()

    def delete_upload(self):
        """يحذف الكشف المرفوع. والقيود التي أُنشئت منه لا صلة لها به."""
        self.unlink()
        return True

    # ------------------------------------------------------------------
    # القيود
    # ------------------------------------------------------------------

    def post_upload(self, sheet='all'):
        """ينشئ قيد الكشف المعروض من الملف، كقيود كشوف الأشهر.

        والقيد يخرج حرّاً بلا ربطٍ بالكشف المرفوع، فيُحذف الكشف ولا
        يتبعه. ويُرجع أسماء ما أُنشئ.
        """
        self.ensure_one()
        if not self.line_ids:
            raise UserError('لا بنود في هذا الكشف.')
        settings = self.env['myaccounting.payroll.settings']._get()
        keys = ([item[0] for item in self._sheets()] if str(sheet) == 'all'
                else [str(sheet)])
        if not keys:
            raise UserError('لا كشف لترحيله.')
        moves = [self._post_sheet(key, settings) for key in keys]
        return {'data': self._payload(),
                'moves': [move.name for move in moves]}

    def _post_sheet(self, sheet, settings):
        self.ensure_one()
        lines = self._sheet_lines(sheet)
        if not lines:
            raise UserError('لا بنود في هذا الكشف.')
        group = lines[0].group_id
        entries, label, journal = sheet_entries(
            lines, group, '%s/%s' % (self.month, self.year), settings)
        return self.env['myaccounting.move'].create({
            'ref': label,
            'journal': journal,
            'line_ids': entries,
        })

class MyAccountingPayrollUploadLine(models.Model):
    _name = 'myaccounting.payroll.upload.line'
    _description = 'بند كشف رواتب مرفوع'
    _order = 'sequence, id'

    upload_id = fields.Many2one('myaccounting.payroll.upload', required=True,
                                ondelete='cascade', index=True)
    sequence = fields.Integer(string='الترتيب', default=10)
    sheet = fields.Char(string='ورقة الملف')
    group_id = fields.Many2one('myaccounting.payroll.group', string='الكشف')
    # الاسم نصٌّ كما في الملف: لا بطاقة له ولا يُنشأ له موظف
    employee = fields.Char(string='الموظف', required=True)
    basic_salary = fields.Float(string='الأساسي', digits=(16, 3))
    allowance = fields.Float(string='العلاوات', digits=(16, 3))
    social_base = fields.Float(string='الخاضع للضمان', digits=(16, 3))
    employee_social = fields.Float(string='ضمان الموظف', digits=(16, 3))
    income_tax = fields.Float(string='ضريبة الدخل', digits=(16, 3))
    pension = fields.Float(string='صندوق التقاعد', digits=(16, 3))
    other_deduction = fields.Float(string='استقطاعات أخرى', digits=(16, 3))
    payment_method = fields.Char(string='طريقة الصرف', default='transfer')
    account_id = fields.Many2one('myaccounting.account', string='حساب المصروف')
    payment_account_id = fields.Many2one('myaccounting.account', string='يُدفع من')

    def _payload(self):
        """بشكل بند كشف الشهر نفسه، فتُعرض جداوله وتُبنى قيوده كما هي."""
        self.ensure_one()
        gross = round((self.basic_salary or 0.0) + (self.allowance or 0.0), 3)
        deduction = round((self.employee_social or 0.0) + (self.income_tax or 0.0)
                          + (self.pension or 0.0) + (self.other_deduction or 0.0), 3)
        settings = self.env['myaccounting.payroll.settings']._get()
        return {
            'id': self.id,
            'employee': self.employee or '',
            'sheet': self.sheet or '',
            'basic_salary': self.basic_salary,
            'allowance': self.allowance,
            'gross': gross,
            'social_base': self.social_base,
            'employee_social': self.employee_social,
            'employer_social': round((self.social_base or 0.0)
                                     * settings.employer_rate / 100.0, 3),
            'income_tax': self.income_tax,
            'pension': self.pension,
            'other_deduction': self.other_deduction,
            'total_deduction': deduction,
            'net': round(gross - deduction, 3),
            'group_id': self.group_id.id or False,
            'group': self.group_id.name or (self.sheet or ''),
            'key': (str(self.group_id.id) if self.group_id
                    else 'x%s' % (self.sheet or '')),
            'method': 'شيك' if self.payment_method == 'cheque' else 'تحويل',
        }
