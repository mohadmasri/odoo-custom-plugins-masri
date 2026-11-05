# -*- coding: utf-8 -*-
"""نظام الرواتب: موظفون، وكشف رواتب شهري، وقيد محاسبي منه.

الحساب على الطريقة المعتادة في الأردن: الراتب الإجمالي ناقص حصة الموظف من
الضمان وضريبة الدخل والاستقطاعات الأخرى = الصافي المدفوع. وحصة الشركة من
الضمان مصروف عليها لا على الموظف.
"""
from odoo import api, fields, models
from odoo.exceptions import UserError

# القائمة ترقّم الشهر قبل اسمه، وكذلك كل تاريخٍ يُكتب: MONTH_LABELS للعناوين
# وMONTH_NAMES للاسم وحده حيث يُحتاج
MONTHS = [
    ('1', '1 - كانون الثاني'), ('2', '2 - شباط'), ('3', '3 - آذار'),
    ('4', '4 - نيسان'), ('5', '5 - أيار'), ('6', '6 - حزيران'),
    ('7', '7 - تموز'), ('8', '8 - آب'), ('9', '9 - أيلول'),
    ('10', '10 - تشرين الأول'), ('11', '11 - تشرين الثاني'),
    ('12', '12 - كانون الأول'),
]

# العناوين تأخذ الاسم وحده: «كشف رواتب أيلول 2026» لا «9 - أيلول»
MONTH_NAMES = {key: label.split(' - ', 1)[-1] for key, label in MONTHS}
MONTH_LABELS = dict(MONTHS)

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


def employer_share(lines, settings):
    """حصة الشركة من الضمان لكل حساب، محسوبةً على مجموع الخاضع للضمان.

    مؤسسة الضمان تحسب النسبة على مجموع الرواتب الخاضعة لا على كل راتب
    منفرداً، فالتقريب يقع مرةً واحدة لكل حساب. وهذا ما في قيوده:
    «ما يخص المكتب» و«ما يخص الشركة» لكل مشروع.
    """
    office = settings.employer_expense_account_id
    base = {}
    for line in lines:
        account = line.account_id or office
        base[account.id] = round(base.get(account.id, 0.0)
                                 + (line.social_base or 0.0), 3)
    return {account_id: round(amount * settings.employer_rate / 100.0, 3)
            for account_id, amount in base.items() if amount}


def sheet_entries(lines, group, period, settings):
    """بنود قيد كشفٍ واحد وترتيبها كما يكتبها هو، ومعها بيانه ويوميته.

    كشف المكتب على نمط قيده 1/9: المصروف، ثم الصافي تحويلاً ثم شيكاتٍ،
    ثم ضمان الموظف وضريبته وتقاعده كلٌّ في بنده، ثم حصة الشركة من
    الضمان بندين: مديناً على حسابها ودائناً على الضمان.

    وكشف المشروع على نمط قيده 20/9: الصافي في آخر القيد بعد حصة
    الشركة، لا بعد المصروف — فآخر ما يُقرأ ما صرفه موفق.

    وضمان الموظف وحصة الشركة لا يُجمعان في الحالين. وتعمل على بنود
    كشف الشهر وعلى بنود كشفٍ مرفوع سواءً.
    """
    payloads = [line._payload() for line in lines]

    def total(key):
        return round(sum(item[key] for item in payloads), 3)

    # المصروف أولاً: منه يُعرف إن كان الكشف للمكتب أو لمشروع
    by_account = {}
    for line in lines:
        account = line.account_id or settings.expense_account_id
        gross = round((line.basic_salary or 0.0) + (line.allowance or 0.0), 3)
        by_account[account.id] = round(by_account.get(account.id, 0.0) + gross, 3)
    # كشف المكتب مصروفه على حساب الرواتب العام، والمشروع على حسابه
    is_office = set(by_account) <= {settings.expense_account_id.id}

    # اللفظ كلفظه: «رواتب المكتب شهر 8/2026» في المكتب،
    # و«رواتب مشروع جرش السياحي شهر 8/2026» في المشروع
    site = ('مشروع %s شهر %s' % (group.name, period) if group
            else 'شهر %s' % period)
    label = ('%s شهر %s' % (group.name, period) if is_office and group
             else 'رواتب %s' % site)

    entries = []

    def add(account, name, debit=0.0, credit=0.0):
        """بندٌ في آخر القيد، برقم ترتيبٍ يحفظ له مكانه."""
        account_id = account.id if hasattr(account, 'id') else account
        if not account_id or not (debit or credit):
            return
        entries.append((0, 0, {
            'sequence': 10 * (len(entries) + 1),
            'account_id': account_id,
            'name': name,
            'debit': debit,
            'credit': credit,
        }))

    # 1) المصروف: لكل حساب مصروفه، والباقي على حساب الرواتب العام
    for account_id, amount in by_account.items():
        add(account_id, label, debit=amount)

    # 2) الصافي: سطرٌ للتحويل وسطرٌ للشيكات على كل جهة دفع.
    # مكانه يختلف: في كشف المكتب بعد المصروف، وفي المشروع في الآخر.
    by_payment = {}
    for line, data in zip(lines, payloads):
        if not data['net']:
            continue
        payment = line.payment_account_id or settings.payment_account_id
        method = line.payment_method or 'transfer'
        key = (payment.id, method)
        by_payment[key] = round(by_payment.get(key, 0.0) + data['net'], 3)

    def add_nets():
        for (account_id, method), amount in sorted(
                by_payment.items(), key=lambda item: (item[0][1] != 'transfer',
                                                      item[0][0])):
            add(account_id, 'شيكات' if method == 'cheque' else label,
                credit=amount)

    if is_office:
        add_nets()

    # 3) استقطاعات الموظف، كلٌّ في بنده
    add(settings.social_account_id,
        'ضمان شهر %s' % period if is_office else 'ضمان %s' % site,
        credit=total('employee_social'))
    add(settings.tax_account_id, 'ذمم دخل %s' % period,
        credit=total('income_tax'))
    if total('pension') and not settings.pension_account_id:
        raise UserError('في الكشف صندوق تقاعد، فحدّد له حساباً في الإعدادات.')
    add(settings.pension_account_id, 'ذمم تقاعد %s' % period,
        credit=total('pension'))
    if total('other_deduction') and not settings.other_account_id:
        raise UserError('في الكشف استقطاعات أخرى، فحدّد لها حساباً في الإعدادات.')
    add(settings.other_account_id, 'استقطاعات أخرى شهر %s' % period,
        credit=total('other_deduction'))

    # 4) حصة الشركة من الضمان: مدينٌ على حسابها، ودائنٌ على الضمان.
    # وهي تتبع حساب الراتب: راتب المشروع حصته على حساب المشروع،
    # وراتب المكتب على حساب اشتراك الضمان.
    office = settings.employer_expense_account_id
    for account_id, amount in employer_share(lines, settings).items():
        own = account_id == office.id
        add(account_id,
            'ما يخص المكتب' if own else 'اشتراك الضمان %s' % site,
            debit=amount)
        add(settings.social_account_id,
            label if own else 'ما يخص الشركة',
            credit=amount)

    # 5) صافي المشروع آخر القيد: ما صرفه موفق، كما في قيده 20/9
    if not is_office:
        add_nets()

    journal = group.journal or ('رواتب المكتب' if is_office else 'رواتب مشاريع')
    return entries, label, journal


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


class MyAccountingPayrollGroup(models.Model):
    """كشف رواتب: مجموعة موظفين لها حساب مصروفها وجهة دفعها.

    هي تبويبات ملف الرواتب نفسها (المكتب، العجزة، كل مشروع على حدة)، فما
    يميّز المشروع — حساب مصروفه ومن يصرف صافيه — يُكتب مرةً على الكشف لا
    على كل بطاقة.
    """
    _name = 'myaccounting.payroll.group'
    _description = 'كشف رواتب (مجموعة موظفين)'
    _order = 'sequence, id'

    name = fields.Char(string='الكشف', required=True)
    sequence = fields.Integer(string='الترتيب', default=10)
    account_id = fields.Many2one('myaccounting.account', string='حساب المصروف',
                                 help='اتركه فارغاً ليُستعمل حساب مصروف الرواتب العام.')
    payment_account_id = fields.Many2one(
        'myaccounting.account', string='يُدفع من',
        help='اتركه فارغاً ليُستعمل حساب الدفع العام.')
    active = fields.Boolean(
        string='فعّال', default=True,
        help='المشروع الذي انتهى يُؤرشف: يخرج من التبويبات ويبقى في الأرشيف '
             'بموظفيه وحساباته، ويعود إن عاد في كشفٍ مرفوع.')
    journal = fields.Char(
        string='اليومية',
        help='يومية قيد هذا الكشف، كما في دفاتره: «رواتب المكتب 1» '
             'و«رواتب مشاريع». واتركها فارغة ليُستعمل الاسم المعتاد.')
    employee_ids = fields.One2many('myaccounting.employee', 'group_id',
                                   string='الموظفون')

    def _payload(self):
        self.ensure_one()
        return {
            'id': self.id,
            'name': self.name or '',
            'sequence': self.sequence,
            'account_id': self.account_id.id or False,
            'account': self.account_id.name or '',
            'payment_account_id': self.payment_account_id.id or False,
            'payment_account': self.payment_account_id.name or '',
            'journal': self.journal or '',
            'active': self.active,
            'count': len(self.with_context(active_test=False).employee_ids),
        }

    JOURNALS = {
        'رواتب المكتب': 'رواتب المكتب 1',
        'المكتب العجزة': 'رواتب المكتب 2',
    }

    @api.model
    def _seed_journals(self):
        """يومية كل كشفٍ كما في دفاتره، مرةً واحدة ولا تُمسّ بعدها."""
        param = self.env['ir.config_parameter'].sudo()
        if param.get_param('my_accounting.payroll_group_journals'):
            return
        for group in self.with_context(active_test=False).search([]):
            if group.journal:
                continue
            group.journal = self.JOURNALS.get(
                group.name, 'رواتب مشاريع' if group.account_id else 'رواتب المكتب')
        param.set_param('my_accounting.payroll_group_journals', '1')

    @api.model
    def get_groups(self):
        self._seed_journals()
        return [group._payload()
                for group in self.with_context(active_test=False).search([])]

    @api.model
    def get_finished(self):
        """المشاريع المنتهية: كشوف رواتبها شهراً شهراً وبطاقات موظفيها.

        الكشف المؤرشف يبقى كما كان: موظفوه (موقوفين) وبنوده في كل شهرٍ
        دخل فيه، فيُقرأ تاريخ المشروع كاملاً في مكانٍ واحد.
        """
        return self._projects(False)

    @api.model
    def get_live(self):
        """المشاريع القائمة: مثل المنتهية، كشوفها وموظفوها شهراً شهراً."""
        return self._projects(True)

    @api.model
    def _projects(self, active):
        Line = self.env['myaccounting.payroll.line']
        items = []
        for group in self.with_context(active_test=False).search(
                [('active', '=', active)]):
            months = {}
            for line in Line.search([('group_id', '=', group.id)]):
                payroll = line.payroll_id
                key = (payroll.year, int(payroll.month))
                month = months.setdefault(key, {
                    'year': payroll.year,
                    'month': payroll.month,
                    'label': MONTH_LABELS.get(payroll.month, ''),
                    'lines': [],
                })
                month['lines'].append(line._payload())
            items.append({
                'id': group.id,
                'name': group.name,
                'account': group.account_id.name or 'حساب الرواتب العام',
                'payment_account': (group.payment_account_id.name
                                    or 'حساب الدفع العام'),
                'journal': group.journal or '',
                'employees': [employee._payload() for employee
                              in group.with_context(active_test=False).employee_ids],
                'months': [months[key] for key in sorted(months, reverse=True)],
            })
        return items

    @api.model
    def save_groups(self, items):
        """يحفظ الكشوف كاملةً: ما حُذف يُحذف وما استجدّ يُنشأ."""
        existing = {group.id: group
                    for group in self.with_context(active_test=False).search([])}
        kept = set()
        for item in items or []:
            name = (item.get('name') or '').strip()
            if not name:
                raise UserError('لا بدّ للكشف من اسم.')
            data = {
                'name': name,
                'sequence': int(item.get('sequence') or 10),
                'account_id': int(item['account_id']) if item.get('account_id') else False,
                'payment_account_id': int(item['payment_account_id'])
                                      if item.get('payment_account_id') else False,
                'journal': (item.get('journal') or '').strip(),
                'active': bool(item.get('active', True)),
            }
            group = existing.get(item.get('id'))
            if group:
                group.write(data)
                kept.add(group.id)
            else:
                kept.add(self.create(data).id)
        gone = self.browse([key for key in existing if key not in kept])
        for group in gone:
            if group.with_context(active_test=False).employee_ids:
                raise UserError('في كشف «%s» موظفون، فانقلهم قبل حذفه.' % group.name)
        if gone:
            gone.unlink()
        return self.get_groups()


class MyAccountingEmployee(models.Model):
    _name = 'myaccounting.employee'
    _description = 'موظف'
    _order = 'sequence, name'

    name = fields.Char(string='الاسم', required=True)
    sequence = fields.Integer(string='الترتيب', default=10)
    group_id = fields.Many2one('myaccounting.payroll.group', string='الكشف',
                               ondelete='restrict')
    job_title = fields.Char(string='المسمّى الوظيفي')
    hire_date = fields.Date(string='تاريخ التعيين')
    active = fields.Boolean(string='على رأس عمله', default=True)

    # بيانات البطاقة: تُعبَّأ من البطاقة لا من جدول الموظفين
    national_id = fields.Char(string='الرقم الوطني')
    social_number = fields.Char(string='رقم الضمان')
    phone = fields.Char(string='الهاتف')
    address = fields.Char(string='العنوان')
    payment_method = fields.Selection([('transfer', 'تحويل'), ('cheque', 'شيك')],
                                      string='طريقة الصرف', default='transfer')

    basic_salary = fields.Float(string='الراتب الأساسي', digits=(16, 3))
    allowance = fields.Float(string='العلاوات', digits=(16, 3))
    social_security = fields.Boolean(string='مشمول بالضمان', default=True)
    social_base = fields.Float(string='الراتب الخاضع للضمان', digits=(16, 3),
                               help='اتركه صفراً ليُحتسب على الراتب الإجمالي.')
    income_tax = fields.Float(string='ضريبة الدخل الشهرية', digits=(16, 3))
    pension = fields.Float(string='صندوق التقاعد الشهري', digits=(16, 3))
    other_deduction = fields.Float(string='استقطاعات أخرى', digits=(16, 3))
    account_id = fields.Many2one('myaccounting.account', string='حساب المصروف',
                                 help='اتركه فارغاً ليُستعمل حساب مصروف الرواتب العام. '
                                      'وحساب المشروع يأخذ معه حصة الشركة من الضمان.')
    payment_account_id = fields.Many2one(
        'myaccounting.account', string='يُدفع من',
        help='اتركه فارغاً ليُستعمل حساب الدفع العام. رواتب المشاريع تُقيَّد '
             'على من يصرفها (موفق هويدي مثلاً) لا على البنك.')
    note = fields.Char(string='ملاحظة')

    def _expense_account(self):
        """حساب مصروف الراتب: ما على البطاقة، وإلا ما على كشفها."""
        self.ensure_one()
        return self.account_id or self.group_id.account_id

    def _payment_account(self):
        """جهة دفع الصافي: ما على البطاقة، وإلا ما على كشفها."""
        self.ensure_one()
        return self.payment_account_id or self.group_id.payment_account_id

    def _payload(self):
        self.ensure_one()
        gross = round((self.basic_salary or 0.0) + (self.allowance or 0.0), 3)
        # ما يقبضه فعلاً: الإجمالي بعد ضمانه وضريبته وتقاعده واستقطاعاته
        settings = self.env['myaccounting.payroll.settings']._get()
        base = (self.social_base or gross) if self.social_security else 0.0
        social = round(base * (settings.employee_rate or 0.0) / 100.0, 3)
        net = round(gross - social - (self.income_tax or 0.0)
                    - (self.pension or 0.0) - (self.other_deduction or 0.0), 3)
        return {
            'id': self.id,
            'name': self.name or '',
            'sequence': self.sequence,
            'group_id': self.group_id.id or False,
            'group': self.group_id.name or '',
            'job_title': self.job_title or '',
            'hire_date': self.hire_date and fields.Date.to_string(self.hire_date) or '',
            'active': self.active,
            'national_id': self.national_id or '',
            'social_number': self.social_number or '',
            'phone': self.phone or '',
            'address': self.address or '',
            'payment_method': self.payment_method or 'transfer',
            'basic_salary': self.basic_salary,
            'allowance': self.allowance,
            'gross': gross,
            'employee_social': social,
            'net': net,
            'social_security': self.social_security,
            'social_base': self.social_base,
            'income_tax': self.income_tax,
            'pension': self.pension,
            'other_deduction': self.other_deduction,
            'account_id': self.account_id.id or False,
            'account': self.account_id.name or '',
            'payment_account_id': self.payment_account_id.id or False,
            'payment_account': self.payment_account_id.name or '',
            'note': self.note or '',
        }

    # ------------------------------------------------------------------
    # بطاقة الموظف
    # ------------------------------------------------------------------

    CARD_TEXT = ('name', 'job_title', 'national_id', 'social_number',
                 'phone', 'address', 'note')
    CARD_MONEY = ('basic_salary', 'allowance', 'social_base', 'income_tax',
                  'pension', 'other_deduction')

    def _card_history(self):
        """سجلّ الموظف الشهري من كشوف الرواتب، أحدثها أولاً."""
        self.ensure_one()
        lines = self.env['myaccounting.payroll.line'].search(
            [('employee_id', '=', self.id)])
        rows = []
        for line in lines:
            payroll = line.payroll_id
            data = line._payload()
            rows.append({
                'id': line.id,
                'payroll_id': payroll.id,
                'payroll': payroll.name or '',
                'year': payroll.year,
                'month': payroll.month,
                'month_label': MONTH_LABELS.get(payroll.month, ''),
                'group': line.group_id.name or 'بلا كشف',
                'basic_salary': data['basic_salary'],
                'allowance': data['allowance'],
                'gross': data['gross'],
                'employee_social': data['employee_social'],
                'income_tax': data['income_tax'],
                'pension': data['pension'],
                'other_deduction': data['other_deduction'],
                'total_deduction': data['total_deduction'],
                'net': data['net'],
            })
        rows.sort(key=lambda row: (row['year'], int(row['month'])), reverse=True)
        return rows

    def _card(self):
        self.ensure_one()
        history = self._card_history()
        keys = ('basic_salary', 'allowance', 'gross', 'employee_social', 'income_tax',
                'pension', 'other_deduction', 'total_deduction', 'net')
        # راتبه كما سيُحتسب في الكشف القادم، بنسبة الضمان المعمول بها
        settings = self.env['myaccounting.payroll.settings']._get()
        gross = round((self.basic_salary or 0.0) + (self.allowance or 0.0), 3)
        base = (self.social_base or gross) if self.social_security else 0.0
        social = round(base * settings.employee_rate / 100.0, 3)
        net = round(gross - social - (self.income_tax or 0.0)
                    - (self.pension or 0.0) - (self.other_deduction or 0.0), 3)
        return {
            'employee': self._payload(),
            'social_base': base,
            'employee_social': social,
            'net': net,
            'expense_account': self._expense_account().name or '',
            'payment_account': self._payment_account().name or '',
            'from_group': not self.account_id and bool(self.group_id.account_id),
            'history': history,
            'months': len(history),
            'totals': {key: round(sum(row[key] for row in history), 3)
                       for key in keys},
        }

    @api.model
    def get_employee_card(self, employee_id):
        employee = self.with_context(active_test=False).browse(int(employee_id))
        if not employee.exists():
            raise UserError('لا بطاقة لهذا الموظف.')
        return employee._card()

    @api.model
    def new_employee_card(self, group_id=False, sequence=10):
        """بطاقة فارغة لموظفٍ جديد، على كشفٍ إن كان معروضاً."""
        group = self.env['myaccounting.payroll.group'].browse(
            int(group_id)) if group_id else self.env['myaccounting.payroll.group']
        employee = {
            'id': False,
            'name': '',
            'sequence': int(sequence or 10),
            'group_id': group.id or False,
            'group': group.name or '',
            'job_title': '',
            'hire_date': '',
            'active': True,
            'national_id': '',
            'social_number': '',
            'phone': '',
            'address': '',
            'payment_method': 'transfer',
            'basic_salary': 0.0,
            'allowance': 0.0,
            'gross': 0.0,
            'social_security': True,
            'social_base': 0.0,
            'income_tax': 0.0,
            'pension': 0.0,
            'other_deduction': 0.0,
            'account_id': False,
            'account': '',
            'payment_account_id': False,
            'payment_account': '',
            'note': '',
        }
        return {
            'employee': employee,
            'social_base': 0.0,
            'employee_social': 0.0,
            'net': 0.0,
            'expense_account': group.account_id.name or '',
            'payment_account': group.payment_account_id.name or '',
            'from_group': bool(group.account_id),
            'history': [],
            'months': 0,
            'totals': {key: 0.0 for key in (
                'basic_salary', 'allowance', 'gross', 'employee_social', 'income_tax',
                'pension', 'other_deduction', 'total_deduction', 'net')},
        }

    @api.model
    def save_employee_card(self, employee_id, values):
        """يحفظ البطاقة كاملةً، وينشئ الموظف إن كانت بطاقة موظفٍ جديد."""
        values = values or {}
        name = (values.get('name') or '').strip()
        if not name:
            raise UserError('لا بدّ للموظف من اسم.')
        data = {field: values.get(field) or '' for field in self.CARD_TEXT}
        data.update({field: float(values.get(field) or 0.0)
                     for field in self.CARD_MONEY})
        data['name'] = name
        data['sequence'] = int(values.get('sequence') or 10)
        data['hire_date'] = values.get('hire_date') or False
        data['social_security'] = bool(values.get('social_security'))
        data['active'] = bool(values.get('active', True))
        data['payment_method'] = values.get('payment_method') or 'transfer'
        data['group_id'] = int(values['group_id']) if values.get('group_id') else False
        data['account_id'] = int(values['account_id']) if values.get('account_id') else False
        data['payment_account_id'] = (int(values['payment_account_id'])
                                      if values.get('payment_account_id') else False)
        if employee_id:
            employee = self.with_context(active_test=False).browse(int(employee_id))
            if not employee.exists():
                raise UserError('لا بطاقة لهذا الموظف.')
            employee.write(data)
        else:
            employee = self.create(data)
        return employee._card()

    @api.model
    def get_employees(self):
        return [employee._payload()
                for employee in self.with_context(active_test=False).search([])]

    @api.model
    def merge_employees(self, employee_ids):
        """يدمج بطاقات رجلٍ واحدٍ كُتب اسمه هجاءً مختلفاً في الملفات.

        الاسم الأطول هو الباقي (فهو أتمّ)، وتنتقل إليه بنود كشوف
        الرواتب من البطاقات الأخرى، وتُنقل إليه بياناتها التي لا يحملها،
        ويبقى على رأس العمل إن كانت إحداها كذلك. ثم تُحذف الأخرى.
        """
        cards = self.with_context(active_test=False).browse(
            [int(item) for item in employee_ids or []]).exists()
        if len(cards) < 2:
            raise UserError('اختر بطاقتين على الأقل للدمج.')
        groups = cards.mapped('group_id')
        if len(groups) > 1:
            raise UserError('البطاقات في كشوفٍ مختلفة (%s)، وهم أشخاصٌ مختلفون.'
                            % '، '.join(groups.mapped('name')))
        keep = max(cards, key=lambda card: (len(card.name or ''), card.id))
        gone = cards - keep
        Line = self.env['myaccounting.payroll.line']
        moved = 0
        for card in gone:
            lines = Line.search([('employee_id', '=', card.id)])
            # شهرٌ فيه بندان للرجل نفسه لا يُجمع: الأحدث بطاقةً هو الباقي
            for line in lines:
                twin = Line.search([('payroll_id', '=', line.payroll_id.id),
                                    ('employee_id', '=', keep.id)], limit=1)
                if twin:
                    line.unlink()
                    continue
                line.employee_id = keep.id
                moved += 1
        # ما ينقص الباقية من بيانات تُؤخذ من الذاهبة
        for field in ('job_title', 'national_id', 'social_number', 'phone',
                      'address', 'note', 'hire_date'):
            if keep[field]:
                continue
            for card in gone:
                if card[field]:
                    keep[field] = card[field]
                    break
        if any(card.active for card in cards):
            keep.active = True
        names = gone.mapped('name')
        gone.unlink()
        return {'keep': keep.name, 'merged': names, 'lines': moved}

    @api.model
    def delete_employee(self, employee_id):
        """يحذف بطاقة موظفٍ لم يدخل كشفاً. ومن دخل يُوقف ولا يُحذف."""
        employee = self.with_context(active_test=False).browse(int(employee_id))
        if not employee.exists():
            return True
        lines = self.env['myaccounting.payroll.line'].search_count(
            [('employee_id', '=', employee.id)])
        if lines:
            raise UserError(
                'للموظف «%s» بنودٌ في %d كشف رواتب، فلا تُحذف بطاقته — '
                'أوقِفه من بطاقته بدلاً من ذلك.' % (employee.name, lines))
        employee.unlink()
        return True

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
                'group_id': int(item['group_id']) if item.get('group_id') else False,
                'job_title': item.get('job_title') or '',
                'hire_date': item.get('hire_date') or False,
                'active': bool(item.get('active', True)),
                'national_id': item.get('national_id') or '',
                'social_number': item.get('social_number') or '',
                'phone': item.get('phone') or '',
                'address': item.get('address') or '',
                'payment_method': item.get('payment_method') or 'transfer',
                'basic_salary': float(item.get('basic_salary') or 0.0),
                'allowance': float(item.get('allowance') or 0.0),
                'social_security': bool(item.get('social_security')),
                'social_base': float(item.get('social_base') or 0.0),
                'income_tax': float(item.get('income_tax') or 0.0),
                'pension': float(item.get('pension') or 0.0),
                'other_deduction': float(item.get('other_deduction') or 0.0),
                'account_id': int(item['account_id']) if item.get('account_id') else False,
                'payment_account_id': int(item['payment_account_id'])
                                      if item.get('payment_account_id') else False,
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
    line_ids = fields.One2many('myaccounting.payroll.line', 'payroll_id',
                               string='البنود')

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
            'lines': len(payroll.line_ids),
        } for payroll in self.search([], limit=60)]

    @api.model
    def get_payroll(self, payroll_id=False):
        payroll = self.browse(int(payroll_id)) if payroll_id else self.search([], limit=1)
        return payroll._payload() if payroll else False

    @api.model
    def get_month(self, year, month):
        """كشف شهرٍ بعينه، أو لا شيء إن لم يُبنَ بعد."""
        payroll = self.search([('year', '=', int(year)),
                               ('month', '=', str(month))], limit=1)
        return payroll._payload() if payroll else False

    @api.model
    def get_last_period(self):
        """آخر شهرٍ له كشف: هو ما تُفتح عليه الصفحة، لا شهر اليوم.

        فالعمل في آخر كشفٍ مرفوع، ودخولُ شهرٍ فارغٍ لا معنى له.
        وإن لم يكن ثمّة كشفٌ بعد فشهر اليوم.
        """
        periods = sorted(((payroll.year, int(payroll.month))
                          for payroll in self.search([])), reverse=True)
        if periods:
            year, month = periods[0]
        else:
            today = fields.Date.context_today(self)
            year, month = today.year, today.month
        return {'year': year, 'month': month}

    @api.model
    def get_years(self):
        """السنوات التي فيها كشوف، ومعها السنة الحالية."""
        years = sorted({payroll.year for payroll in self.search([])}
                       | {fields.Date.context_today(self).year}, reverse=True)
        return years

    def _employer_share(self, lines=None):
        """حصة الشركة من الضمان لكل حساب (انظر employer_share)."""
        self.ensure_one()
        settings = self.env['myaccounting.payroll.settings']._get()
        return employer_share(self.line_ids if lines is None else lines, settings)

    def _sheets(self):
        """كشوف هذا الشهر بترتيبها، و«بلا كشف» في آخرها إن وُجد.

        المفتاح نصّ: رقم الكشف، أو 'none' لمن لا كشف له.
        """
        self.ensure_one()
        groups = self.line_ids.group_id.sorted(lambda group: (group.sequence, group.id))
        sheets = [(str(group.id), group) for group in groups]
        if any(not line.group_id for line in self.line_ids):
            sheets.append(('none', self.env['myaccounting.payroll.group']))
        return sheets

    def _sheet_lines(self, sheet):
        """بنود كشفٍ بعينه."""
        self.ensure_one()
        if str(sheet) == 'none':
            return self.line_ids.filtered(lambda line: not line.group_id)
        return self.line_ids.filtered(lambda line: line.group_id.id == int(sheet))

    def _sheet_keys(self, sheet):
        """ما يشمله الزرّ: كشوف الشهر كلها عند «عرض الكل»، أو الكشف المختار."""
        self.ensure_one()
        if str(sheet) == 'all':
            return [key for key, _group in self._sheets()]
        key = str(sheet)
        return [key] if key in [item for item, _group in self._sheets()] else []

    def _sheets_payload(self):
        self.ensure_one()
        return [{
            'key': key,
            'id': group.id or False,
            'name': group.name or 'بلا كشف',
            'count': len(self._sheet_lines(key)),
        } for key, group in self._sheets()]

    def _payload(self):
        self.ensure_one()
        lines = [line._payload() for line in self.line_ids]
        def total(key):
            return round(sum(line[key] for line in lines), 3)
        employer = round(sum(self._employer_share().values()), 3)
        sheets = self._sheets_payload()
        return {
            'id': self.id,
            'name': self.name,
            'year': self.year,
            'month': self.month,
            'month_label': MONTH_LABELS.get(self.month, ''),
            'date': self.date and fields.Date.to_string(self.date) or '',
            'lines': lines,
            'totals': dict({key: total(key) for key in (
                'basic_salary', 'allowance', 'gross', 'social_base',
                'employee_social', 'employer_social', 'income_tax', 'pension',
                'other_deduction', 'total_deduction', 'net')},
                employer_social=employer),
            'sheets': sheets,
        }

    @api.model
    def apply_sheet_file(self, content, options=None, year=False, month=False):
        """عملية الصفحة: ملف الشهر يُطبَّق على البطاقات ثم يُبنى منه الكشف.

        فالموافقة على الفرق تفعل الأمرين معاً: تعديل البطاقات وإضافة من
        استجدّ وإيقاف من غاب وأرشفة ما انتهى من المشاريع، ثم بناء كشف
        ذلك الشهر من البطاقات بعدها.
        """
        year, month = int(year or 0), str(month or '')
        if not (year and month and month.isdigit() and 1 <= int(month) <= 12):
            raise UserError('لم أعرف شهر الملف، فاختره بنفسك قبل الموافقة.')
        applied = self.env['myaccounting.employee'].apply_excel(
            content, options or {})
        payroll = self.search([('year', '=', year), ('month', '=', month)], limit=1)
        if not payroll:
            payroll = self.create({
                'name': 'رواتب شهر %s/%s' % (month, year),
                'year': year,
                'month': month,
            })
        payroll.fill_from_employees()
        return {'applied': applied, 'data': payroll._payload()}

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
        # يُفتح فارغاً: يبنيه من البطاقات أو يرفع كشف إكسل أولاً
        return payroll.id

    def fill_from_employees(self):
        """يعيد بناء بنود الكشف من بطاقات الموظفين على رأس عملهم."""
        self.ensure_one()
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
                'group_id': employee.group_id.id or False,
                'account_id': employee._expense_account().id or False,
                'payment_account_id': employee._payment_account().id or False,
            })
        return self._payload()

    @api.model
    def save_lines(self, payroll_id, items):
        payroll = self.browse(int(payroll_id))
        by_id = {line.id: line for line in payroll.line_ids}
        changed = self.env['myaccounting.payroll.line']
        names = ('basic_salary', 'allowance', 'social_base', 'employee_social',
                 'employer_social', 'income_tax', 'pension', 'other_deduction')
        for item in items or []:
            line = by_id.get(item.get('id'))
            if not line:
                continue
            values = {name: float(item.get(name) or 0.0) for name in names}
            # الشاشة ترسل بنود الشهر كلها، فما لم يتغيّر لا يُكتب ولا يُمنع
            if all(abs(values[name] - (line[name] or 0.0)) < 0.0005 for name in names):
                continue
            line.write(values)
            changed |= line
        if changed:
            payroll._apply_to_cards(changed)
        return payroll._payload()

    def _apply_to_cards(self, lines):
        """تعديل الكشف يسري على بطاقة الموظف ومن ذلك الشهر فصاعداً.

        فمن رُفع راتبه في شهرٍ يُرفع على بطاقته، فتأخذه الأشهر التي تُبنى
        بعدها، وتأخذه كشوف الأشهر التالية الموجودة ما دامت مسودةً. وما
        رُحِّل من الأشهر لا يُمسّ.
        """
        self.ensure_one()
        names = ('basic_salary', 'allowance', 'social_base', 'employee_social',
                 'income_tax', 'pension', 'other_deduction')
        later = self.search([]).filtered(
            lambda payroll: (payroll.year, int(payroll.month))
                            > (self.year, int(self.month)))
        for line in lines:
            values = {name: line[name] for name in names}
            # البطاقة لا تحفظ حصة الموظف من الضمان، فهي تُحتسب بالنسبة
            line.employee_id.write({name: value for name, value in values.items()
                                    if name != 'employee_social'})
            for payroll in later:
                twin = payroll.line_ids.filtered(
                    lambda item: item.employee_id == line.employee_id)
                if not twin:
                    continue
                twin.write(values)

    def delete_payroll(self):
        """يحذف الكشف وبنوده. والقيود التي أُنشئت منه لا صلة لها به."""
        self.unlink()
        return True

    # ------------------------------------------------------------------
    # القيد
    # ------------------------------------------------------------------

    def post_payroll(self, sheet='all'):
        """ينشئ قيد الكشف المعروض مسودةً: قيداً لكل كشف على حِدة.

        هكذا دفاتره: قيدٌ لرواتب المكتب وقيدٌ لكل مشروع، لا قيدٌ واحد
        يجمعها. فالزرّ ينشئ قيد الكشف المختار من الشريط، وعند «عرض
        الكل» ينشئ قيد كل كشف.

        والقيد يخرج حرّاً: لا يُحفظ له ربطٌ بالكشف، فالكشف يُعدَّل
        ويُحذف بعده ولا يتبعه، وإن أنشأتَه مرّتين صار في الدفتر قيدان.
        ويُرجع أسماء ما أُنشئ.
        """
        self.ensure_one()
        if not self.line_ids:
            raise UserError('لا بنود في الكشف.')
        settings = self.env['myaccounting.payroll.settings']._get()
        optional = ('other_account_id', 'pension_account_id')
        missing = [label for field, label, _default in SETTING_ACCOUNTS
                   if not settings[field] and field not in optional]
        if missing:
            raise UserError('حدّد في الإعدادات: %s' % '، '.join(missing))

        keys = self._sheet_keys(sheet)
        if not keys:
            raise UserError('لا كشف لترحيله.')
        moves = [self._post_sheet(key, settings) for key in keys]
        return {'data': self._payload(),
                'moves': [move.name for move in moves]}

    def _post_sheet(self, sheet, settings):
        """قيد كشفٍ واحد من بنوده (انظر sheet_entries)."""
        self.ensure_one()
        lines = self._sheet_lines(sheet)
        if not lines:
            raise UserError('لا بنود في هذا الكشف.')
        group = lines[0].group_id
        entries, label, journal = sheet_entries(
            lines, group, '%s/%s' % (self.month, self.year), settings)
        # القيد يدخل كأي قيدٍ جديد: رقمه وتاريخه وشهره المحاسبي من
        # افتراضات القيد نفسها، فلا ترقيم خاصّ بالرواتب
        return self.env['myaccounting.move'].create({
            'ref': label,
            'journal': journal,
            'line_ids': entries,
        })

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
    group_id = fields.Many2one('myaccounting.payroll.group', string='الكشف')
    account_id = fields.Many2one('myaccounting.account', string='حساب المصروف')
    payment_account_id = fields.Many2one('myaccounting.account', string='يُدفع من')
    # تُقرأ من البطاقة وقت الحاجة، فتغييرها على البطاقة يسري على المسودة
    payment_method = fields.Char(string='طريقة الصرف',
                                 compute='_compute_payment_method')

    def _compute_payment_method(self):
        for line in self:
            line.payment_method = line.employee_id.payment_method or 'transfer'

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
            'payment_account': self.payment_account_id.name or '',
            'group_id': self.group_id.id or False,
            'group': self.group_id.name or '',
        }
