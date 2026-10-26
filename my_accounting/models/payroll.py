# -*- coding: utf-8 -*-
"""نظام الرواتب: موظفون، وكشف رواتب شهري، وقيد محاسبي منه.

الحساب على الطريقة المعتادة في الأردن: الراتب الإجمالي ناقص حصة الموظف من
الضمان وضريبة الدخل والاستقطاعات الأخرى = الصافي المدفوع. وحصة الشركة من
الضمان مصروف عليها لا على الموظف.
"""
from odoo import api, fields, models
from odoo.exceptions import UserError

MONTHS = [
    ('1', 'كانون الثاني'), ('2', 'شباط'), ('3', 'آذار'), ('4', 'نيسان'),
    ('5', 'أيار'), ('6', 'حزيران'), ('7', 'تموز'), ('8', 'آب'),
    ('9', 'أيلول'), ('10', 'تشرين الأول'), ('11', 'تشرين الثاني'), ('12', 'كانون الأول'),
]

MONTH_NAMES = dict(MONTHS)

# الحسابات التي يحتاجها قيد الرواتب، واسم كل منها في الإعدادات
SETTING_ACCOUNTS = [
    ('expense_account_id', 'حساب مصروف الرواتب', 'الرواتب'),
    ('employer_expense_account_id', 'حساب حصة الشركة من الضمان', 'اشتراك الضمان'),
    ('social_account_id', 'حساب الضمان الاجتماعي', 'الضمان الاجتماعي'),
    ('tax_account_id', 'حساب ضريبة الدخل', 'ضريبة الدخل'),
    ('pension_account_id', 'حساب صندوق التقاعد', 'صندوق التقاعد'),
    ('payment_account_id', 'حساب الدفع', 'الاهلي'),
    ('other_account_id', 'حساب الاستقطاعات الأخرى', ''),
]


class MyAccountingPayrollSettings(models.Model):
    _name = 'myaccounting.payroll.settings'
    _description = 'إعدادات الرواتب'

    name = fields.Char(default='إعدادات الرواتب')
    employee_rate = fields.Float(string='حصة الموظف من الضمان %', digits=(16, 3), default=7.5)
    employer_rate = fields.Float(string='حصة الشركة من الضمان %', digits=(16, 3), default=14.25)
    expense_account_id = fields.Many2one('myaccounting.account', string='مصروف الرواتب')
    employer_expense_account_id = fields.Many2one('myaccounting.account',
                                                  string='مصروف حصة الشركة')
    social_account_id = fields.Many2one('myaccounting.account', string='الضمان الاجتماعي')
    tax_account_id = fields.Many2one('myaccounting.account', string='ضريبة الدخل')
    pension_account_id = fields.Many2one('myaccounting.account', string='صندوق التقاعد')
    payment_account_id = fields.Many2one('myaccounting.account', string='حساب الدفع')
    other_account_id = fields.Many2one('myaccounting.account',
                                       string='الاستقطاعات الأخرى')

    @api.model
    def _get(self):
        settings = self.search([], limit=1) or self.create({})
        # خانة فارغة تُملأ من حساب يحمل الاسم المعتاد — يلزم أيضاً حين
        # يُضاف حقل جديد بعد إنشاء الإعدادات (صندوق التقاعد مثلاً)
        Account = self.env['myaccounting.account']
        values = {}
        for field, _label, default_name in SETTING_ACCOUNTS:
            if settings[field] or not default_name:
                continue
            account = Account.search([('name', '=', default_name)], limit=1)
            if account:
                values[field] = account.id
        if values:
            settings.write(values)
        return settings

    @api.model
    def get_settings(self):
        settings = self._get()
        return {
            'id': settings.id,
            'employee_rate': settings.employee_rate,
            'employer_rate': settings.employer_rate,
            'accounts': [{
                'field': field,
                'label': label,
                'id': settings[field].id or False,
                'name': settings[field].name or '',
            } for field, label, _default in SETTING_ACCOUNTS],
        }

    @api.model
    def save_settings(self, values):
        settings = self._get()
        data = {}
        for key in ('employee_rate', 'employer_rate'):
            if key in values:
                data[key] = float(values[key] or 0.0)
        for field, _label, _default in SETTING_ACCOUNTS:
            if field in values:
                data[field] = int(values[field]) if values[field] else False
        settings.write(data)
        return self.get_settings()


class MyAccountingEmployee(models.Model):
    _name = 'myaccounting.employee'
    _description = 'موظف'
    _order = 'sequence, name'

    name = fields.Char(string='الاسم', required=True)
    sequence = fields.Integer(string='الترتيب', default=10)
    job_title = fields.Char(string='المسمّى الوظيفي')
    hire_date = fields.Date(string='تاريخ التعيين')
    active = fields.Boolean(string='على رأس عمله', default=True)

    basic_salary = fields.Float(string='الراتب الأساسي', digits=(16, 3))
    allowance = fields.Float(string='العلاوات', digits=(16, 3))
    social_security = fields.Boolean(string='مشمول بالضمان', default=True)
    social_base = fields.Float(string='الراتب الخاضع للضمان', digits=(16, 3),
                               help='اتركه صفراً ليُحتسب على الراتب الإجمالي.')
    income_tax = fields.Float(string='ضريبة الدخل الشهرية', digits=(16, 3))
    pension = fields.Float(string='صندوق التقاعد الشهري', digits=(16, 3))
    other_deduction = fields.Float(string='استقطاعات أخرى', digits=(16, 3))
    account_id = fields.Many2one('myaccounting.account', string='حساب المصروف',
                                 help='اتركه فارغاً ليُستعمل حساب مصروف الرواتب العام.')
    note = fields.Char(string='ملاحظة')

    def _payload(self):
        self.ensure_one()
        gross = round((self.basic_salary or 0.0) + (self.allowance or 0.0), 3)
        return {
            'id': self.id,
            'name': self.name or '',
            'sequence': self.sequence,
            'job_title': self.job_title or '',
            'hire_date': self.hire_date and fields.Date.to_string(self.hire_date) or '',
            'active': self.active,
            'basic_salary': self.basic_salary,
            'allowance': self.allowance,
            'gross': gross,
            'social_security': self.social_security,
            'social_base': self.social_base,
            'income_tax': self.income_tax,
            'pension': self.pension,
            'other_deduction': self.other_deduction,
            'account_id': self.account_id.id or False,
            'account': self.account_id.name or '',
            'note': self.note or '',
        }

    @api.model
    def get_employees(self):
        return [employee._payload()
                for employee in self.with_context(active_test=False).search([])]

    @api.model
    def save_employees(self, items):
        """يحفظ قائمة الموظفين كاملة: ما حُذف يُحذف وما استجدّ يُنشأ."""
        existing = {employee.id: employee
                    for employee in self.with_context(active_test=False).search([])}
        kept = set()
        for item in items or []:
            name = (item.get('name') or '').strip()
            if not name:
                raise UserError('لا بدّ للموظف من اسم.')
            data = {
                'name': name,
                'sequence': int(item.get('sequence') or 10),
                'job_title': item.get('job_title') or '',
                'hire_date': item.get('hire_date') or False,
                'active': bool(item.get('active', True)),
                'basic_salary': float(item.get('basic_salary') or 0.0),
                'allowance': float(item.get('allowance') or 0.0),
                'social_security': bool(item.get('social_security')),
                'social_base': float(item.get('social_base') or 0.0),
                'income_tax': float(item.get('income_tax') or 0.0),
                'pension': float(item.get('pension') or 0.0),
                'other_deduction': float(item.get('other_deduction') or 0.0),
                'account_id': int(item['account_id']) if item.get('account_id') else False,
                'note': item.get('note') or '',
            }
            employee = existing.get(item.get('id'))
            if employee:
                employee.write(data)
                kept.add(employee.id)
            else:
                kept.add(self.create(data).id)
        gone = self.browse([key for key in existing if key not in kept])
        if gone:
            gone.unlink()
        return self.get_employees()


class MyAccountingPayroll(models.Model):
    _name = 'myaccounting.payroll'
    _description = 'كشف رواتب شهري'
    _order = 'year desc, month desc, id desc'

    name = fields.Char(string='الكشف', required=True)
    year = fields.Integer(string='السنة', required=True)
    month = fields.Selection(MONTHS, string='الشهر', required=True)
    date = fields.Date(string='تاريخ القيد', default=fields.Date.context_today)
    state = fields.Selection([('draft', 'مسودة'), ('posted', 'مُرحَّل')],
                             string='الحالة', default='draft')
    line_ids = fields.One2many('myaccounting.payroll.line', 'payroll_id', string='البنود')
    move_id = fields.Many2one('myaccounting.move', string='القيد', ondelete='set null')

    _year_month_unique = models.Constraint('unique(year, month)',
                                           'لكل شهر كشف رواتب واحد.')

    # ------------------------------------------------------------------

    @api.model
    def get_payrolls(self):
        return [{
            'id': payroll.id,
            'name': payroll.name,
            'year': payroll.year,
            'month': payroll.month,
            'state': payroll.state,
            'lines': len(payroll.line_ids),
        } for payroll in self.search([], limit=60)]

    @api.model
    def get_payroll(self, payroll_id=False):
        payroll = self.browse(int(payroll_id)) if payroll_id else self.search([], limit=1)
        return payroll._payload() if payroll else False

    def _payload(self):
        self.ensure_one()
        lines = [line._payload() for line in self.line_ids]
        def total(key):
            return round(sum(line[key] for line in lines), 3)
        return {
            'id': self.id,
            'name': self.name,
            'year': self.year,
            'month': self.month,
            'month_label': MONTH_NAMES.get(self.month, ''),
            'date': self.date and fields.Date.to_string(self.date) or '',
            'state': self.state,
            'lines': lines,
            'totals': {key: total(key) for key in (
                'basic_salary', 'allowance', 'gross', 'social_base',
                'employee_social', 'employer_social', 'income_tax', 'pension',
                'other_deduction', 'total_deduction', 'net')},
            'move_id': self.move_id.id or False,
            'move': self.move_id.name or '',
        }

    @api.model
    def create_payroll(self, year, month):
        """ينشئ كشف الشهر ويملؤه من بطاقات الموظفين."""
        year, month = int(year), str(month)
        if self.search([('year', '=', year), ('month', '=', month)], limit=1):
            raise UserError('يوجد كشف لهذا الشهر.')
        payroll = self.create({
            'name': 'رواتب شهر %s/%s' % (month, year),
            'year': year,
            'month': month,
        })
        payroll.fill_from_employees()
        return payroll.id

    def fill_from_employees(self):
        """يعيد بناء بنود الكشف من بطاقات الموظفين على رأس عملهم."""
        self.ensure_one()
        if self.state == 'posted':
            raise UserError('الكشف مُرحَّل، لا يُعاد بناؤه.')
        self.line_ids.unlink()
        settings = self.env['myaccounting.payroll.settings']._get()
        Line = self.env['myaccounting.payroll.line']
        for employee in self.env['myaccounting.employee'].search([]):
            gross = round((employee.basic_salary or 0.0) + (employee.allowance or 0.0), 3)
            base = employee.social_base or gross
            Line.create({
                'payroll_id': self.id,
                'employee_id': employee.id,
                'basic_salary': employee.basic_salary,
                'allowance': employee.allowance,
                'social_base': base if employee.social_security else 0.0,
                'employee_social': round(base * settings.employee_rate / 100.0, 3)
                                   if employee.social_security else 0.0,
                'employer_social': round(base * settings.employer_rate / 100.0, 3)
                                   if employee.social_security else 0.0,
                'income_tax': employee.income_tax,
                'pension': employee.pension,
                'other_deduction': employee.other_deduction,
                'account_id': employee.account_id.id or False,
            })
        return self._payload()

    @api.model
    def save_lines(self, payroll_id, items):
        payroll = self.browse(int(payroll_id))
        if payroll.state == 'posted':
            raise UserError('الكشف مُرحَّل، لا يُعدَّل.')
        by_id = {line.id: line for line in payroll.line_ids}
        for item in items or []:
            line = by_id.get(item.get('id'))
            if not line:
                continue
            line.write({
                'basic_salary': float(item.get('basic_salary') or 0.0),
                'allowance': float(item.get('allowance') or 0.0),
                'social_base': float(item.get('social_base') or 0.0),
                'employee_social': float(item.get('employee_social') or 0.0),
                'employer_social': float(item.get('employer_social') or 0.0),
                'income_tax': float(item.get('income_tax') or 0.0),
                'pension': float(item.get('pension') or 0.0),
                'other_deduction': float(item.get('other_deduction') or 0.0),
            })
        return payroll._payload()

    def delete_payroll(self):
        for payroll in self:
            if payroll.state == 'posted':
                raise UserError('الكشف مُرحَّل، لا يُحذف.')
        self.unlink()
        return True

    # ------------------------------------------------------------------
    # القيد
    # ------------------------------------------------------------------

    def post_payroll(self):
        """ينشئ قيد الرواتب مسودةً من مجاميع الكشف."""
        self.ensure_one()
        if self.state == 'posted':
            raise UserError('سبق ترحيل هذا الكشف.')
        if not self.line_ids:
            raise UserError('لا بنود في الكشف.')
        settings = self.env['myaccounting.payroll.settings']._get()
        optional = ('other_account_id', 'pension_account_id')
        missing = [label for field, label, _default in SETTING_ACCOUNTS
                   if not settings[field] and field not in optional]
        if missing:
            raise UserError('حدّد في الإعدادات: %s' % '، '.join(missing))

        payload = self._payload()
        totals = payload['totals']
        label = 'رواتب شهر %s/%s' % (self.month, self.year)
        lines = []
        # المصروف: لكل حساب مصروفه، والباقي على حساب الرواتب العام
        by_account = {}
        for line in self.line_ids:
            account = line.account_id or settings.expense_account_id
            gross = round((line.basic_salary or 0.0) + (line.allowance or 0.0), 3)
            by_account[account.id] = round(by_account.get(account.id, 0.0) + gross, 3)
        for account_id, amount in by_account.items():
            if amount:
                lines.append((0, 0, {'account_id': account_id, 'name': label,
                                     'debit': amount, 'credit': 0.0}))
        if totals['employer_social']:
            lines.append((0, 0, {
                'account_id': settings.employer_expense_account_id.id,
                'name': 'حصة الشركة من الضمان %s' % label,
                'debit': totals['employer_social'], 'credit': 0.0}))
        social = round(totals['employee_social'] + totals['employer_social'], 3)
        if social:
            lines.append((0, 0, {
                'account_id': settings.social_account_id.id,
                'name': 'الضمان الاجتماعي %s' % label,
                'debit': 0.0, 'credit': social}))
        if totals['income_tax']:
            lines.append((0, 0, {
                'account_id': settings.tax_account_id.id,
                'name': 'ضريبة الدخل %s' % label,
                'debit': 0.0, 'credit': totals['income_tax']}))
        if totals['pension']:
            if not settings.pension_account_id:
                raise UserError('في الكشف صندوق تقاعد، فحدّد له حساباً في الإعدادات.')
            lines.append((0, 0, {
                'account_id': settings.pension_account_id.id,
                'name': 'صندوق التقاعد %s' % label,
                'debit': 0.0, 'credit': totals['pension']}))
        if totals['other_deduction']:
            if not settings.other_account_id:
                raise UserError('في الكشف استقطاعات أخرى، فحدّد لها حساباً في الإعدادات.')
            lines.append((0, 0, {
                'account_id': settings.other_account_id.id,
                'name': 'استقطاعات أخرى %s' % label,
                'debit': 0.0, 'credit': totals['other_deduction']}))
        if totals['net']:
            lines.append((0, 0, {
                'account_id': settings.payment_account_id.id,
                'name': label,
                'debit': 0.0, 'credit': totals['net']}))

        move = self.env['myaccounting.move'].create({
            'name': self._next_move_name(),
            'date': self.date or fields.Date.context_today(self),
            'ref': label,
            'journal': 'رواتب',
            'ledger_year': self.year,
            'ledger_month': self.month,
            'line_ids': lines,
        })
        self.write({'state': 'posted', 'move_id': move.id})
        return self._payload()

    def _next_move_name(self):
        """رقم القيد في شهر الكشف: ما بعد آخر رقم في الشهر نفسه."""
        self.ensure_one()
        moves = self.env['myaccounting.move'].search([
            ('ledger_year', '=', self.year), ('ledger_month', '=', self.month)])
        numbers = []
        for move in moves:
            parts = (move.name or '').split('/')
            if len(parts) == 2 and parts[0].strip().isdigit():
                numbers.append(int(parts[0].strip()))
        return '%d/%s' % ((max(numbers) + 1) if numbers else 1, self.month)

    def unpost_payroll(self):
        """يفكّ الترحيل ويحذف القيد ما دام مسودة."""
        self.ensure_one()
        move = self.move_id
        self.write({'state': 'draft', 'move_id': False})
        if move and move.state == 'draft':
            move.unlink()
        return self._payload()


class MyAccountingPayrollLine(models.Model):
    _name = 'myaccounting.payroll.line'
    _description = 'بند كشف رواتب'
    _order = 'id'

    payroll_id = fields.Many2one('myaccounting.payroll', required=True, ondelete='cascade')
    employee_id = fields.Many2one('myaccounting.employee', string='الموظف',
                                  required=True, ondelete='restrict')
    basic_salary = fields.Float(string='الأساسي', digits=(16, 3))
    allowance = fields.Float(string='العلاوات', digits=(16, 3))
    social_base = fields.Float(string='الخاضع للضمان', digits=(16, 3))
    employee_social = fields.Float(string='ضمان الموظف', digits=(16, 3))
    employer_social = fields.Float(string='ضمان الشركة', digits=(16, 3))
    income_tax = fields.Float(string='ضريبة الدخل', digits=(16, 3))
    pension = fields.Float(string='صندوق التقاعد', digits=(16, 3))
    other_deduction = fields.Float(string='استقطاعات أخرى', digits=(16, 3))
    account_id = fields.Many2one('myaccounting.account', string='حساب المصروف')

    def _payload(self):
        self.ensure_one()
        gross = round((self.basic_salary or 0.0) + (self.allowance or 0.0), 3)
        deduction = round((self.employee_social or 0.0) + (self.income_tax or 0.0)
                          + (self.pension or 0.0) + (self.other_deduction or 0.0), 3)
        return {
            'id': self.id,
            'employee_id': self.employee_id.id,
            'employee': self.employee_id.name or '',
            'job_title': self.employee_id.job_title or '',
            'basic_salary': self.basic_salary,
            'allowance': self.allowance,
            'gross': gross,
            'social_base': self.social_base,
            'employee_social': self.employee_social,
            'employer_social': self.employer_social,
            'income_tax': self.income_tax,
            'pension': self.pension,
            'other_deduction': self.other_deduction,
            'total_deduction': deduction,
            'net': round(gross - deduction, 3),
            'account': self.account_id.name or '',
        }
