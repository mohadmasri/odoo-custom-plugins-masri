# -*- coding: utf-8 -*-
"""مطابقة كشف رواتب إكسل ببطاقات الموظفين.

ملفه كشفٌ لكل جهة في ورقة، وأعمدته: الاسم، الراتب المستحق، العلاوات،
العمل الإضافي، المجموع، الدخل، الضمان، السلف، صافي الراتب، التوقيع
(وفيه «شيك» لمن يُصرف له شيكاً).

والرفع لا يبني كشف الشهر: إنما يعدّل البطاقات — يُنشئ من استجدّ، ويعدّل
من تغيّر، ويوقف من غاب عن الملف — ثم يُبنى الكشف من البطاقات. ولذلك
يصلح رفع ملف شهرٍ ماضٍ أو قادم.
"""
import base64
import io

from odoo import api, models
from odoo.exceptions import UserError

# ترويسات أعمدة ملفه، وما تقابله من حقول البطاقة
HEADERS = {
    'الاسم': 'name',
    'الراتب الأساسي': 'declared',
    'الراتب المستحق': 'due',
    'العلاوات': 'allowance',
    'العمل الإضافي': 'overtime',
    'المجموع': 'gross',
    'صافي الراتب': 'net',
    'التوقيع': 'sign',
    'الدخل': 'income_tax',
}
TOTAL_WORDS = ('المجاميع', 'المجموع', 'الاجمالي', 'الإجمالي')
# ما يُقارن من حقول البطاقة، وعنوان كل حقل في شاشة الفرق
COMPARED = (
    ('basic_salary', 'الراتب الأساسي'),
    ('allowance', 'العلاوات'),
    ('social_security', 'مشمول بالضمان'),
    ('social_base', 'الخاضع للضمان'),
    ('income_tax', 'ضريبة الدخل'),
    ('pension', 'السلف'),
    ('payment_method', 'طريقة الصرف'),
    ('group_id', 'الكشف'),
    ('active', 'على رأس عمله'),
)
METHODS = {'transfer': 'تحويل', 'cheque': 'شيك'}


def clean(value):
    return ' '.join(str(value or '').split())


def match_key(name):
    """مفتاح المطابقة: بلا همزاتٍ ولا تطويلٍ ولا فراغات."""
    text = clean(name)
    for bad, good in (('أ', 'ا'), ('إ', 'ا'), ('آ', 'ا'), ('ى', 'ي'),
                      ('ة', 'ه'), ('ـ', '')):
        text = text.replace(bad, good)
    return text.replace(' ', '')


def number(value):
    try:
        return round(float(value or 0.0), 3)
    except (TypeError, ValueError):
        return 0.0


class MyAccountingEmployeeExcel(models.Model):
    _inherit = 'myaccounting.employee'

    # ------------------------------------------------------------------
    # قراءة الملف
    # ------------------------------------------------------------------

    @api.model
    def _excel_rows(self, content):
        """صفوف الملف: لكل موظفٍ سطرٌ يحمل ورقته وأرقامه."""
        try:
            import openpyxl
        except ImportError:
            raise UserError('مكتبة قراءة ملفات Excel غير متوفرة على الخادم (openpyxl).')
        try:
            data = base64.b64decode(content or '')
            book = openpyxl.load_workbook(io.BytesIO(data), data_only=True)
        except Exception:
            raise UserError('تعذّرت قراءة الملف. تأكّد أنه ملف Excel بصيغة .xlsx سليم.')

        rows = []
        skipped = []
        for sheet in book.worksheets:
            grid = list(sheet.iter_rows(values_only=True))
            columns, head = {}, None
            # الترويسة قد تكون على سطرين: «الاقتطاعات» ثم «الدخل/ضمان/سلف»
            for index, line in enumerate(grid[:12]):
                for position, cell in enumerate(line or ()):
                    text = clean(cell)
                    if not text:
                        continue
                    if text in HEADERS:
                        columns.setdefault(HEADERS[text], position)
                    elif 'ضمان' in text:
                        columns.setdefault('social', position)
                    elif 'سلف' in text:
                        columns.setdefault('pension', position)
                if 'name' in columns and head is None:
                    head = index
            if head is None or not ('gross' in columns or 'due' in columns):
                skipped.append(sheet.title)
                continue
            for line in grid[head + 1:]:
                if not line:
                    continue
                name = clean(line[columns['name']]
                             if columns['name'] < len(line) else '')
                if not name or any(name.startswith(word) for word in TOTAL_WORDS):
                    continue
                if name in HEADERS:
                    continue

                def cell(key):
                    position = columns.get(key)
                    if position is None or position >= len(line):
                        return None
                    return line[position]

                due = number(cell('due')) or number(cell('declared'))
                allowance = round(number(cell('allowance'))
                                  + number(cell('overtime')), 3)
                gross = number(cell('gross')) or round(due + allowance, 3)
                rows.append({
                    'sheet': clean(sheet.title),
                    'name': name,
                    'basic_salary': due,
                    'allowance': allowance,
                    'gross': gross,
                    'income_tax': number(cell('income_tax')),
                    'social': number(cell('social')),
                    'pension': number(cell('pension')),
                    'net': number(cell('net')),
                    'cheque': 'شيك' in clean(cell('sign')),
                })
        if not rows:
            raise UserError('لم أجد صفوف موظفين في الملف. '
                            'المنتظر ملف كشف الرواتب بأوراقه وأعمدته المعتادة.')
        return rows, skipped

    def _excel_card_values(self, row):
        """قيم البطاقة من صف الملف: الضمان يُستنتج من المقتطع."""
        settings = self.env['myaccounting.payroll.settings']._get()
        rate = settings.employee_rate or 0.0
        social = row['social']
        base = 0.0
        if social and rate:
            # ما طابق النسبة على الإجمالي يُترك فارغاً ليُحتسب، وما خالفها
            # يُكتب خاضعاً صريحاً كما في بطاقة هلا حمدان
            expected = round(row['gross'] * rate / 100.0, 3)
            if abs(social - expected) > 0.005:
                base = round(social * 100.0 / rate, 3)
        return {
            'basic_salary': row['basic_salary'],
            'allowance': row['allowance'],
            'social_security': bool(social),
            'social_base': base,
            'income_tax': row['income_tax'],
            'pension': row['pension'],
            'payment_method': 'cheque' if row['cheque'] else 'transfer',
            'active': True,
        }

    # ------------------------------------------------------------------
    # المقارنة بالبطاقات
    # ------------------------------------------------------------------

    @api.model
    def _excel_plan(self, content):
        """خطة الرفع: ما يُعدَّل وما يُضاف وما يُوقف، وما استجدّ من كشوف."""
        rows, skipped = self._excel_rows(content)
        Group = self.env['myaccounting.payroll.group']
        employees = self.with_context(active_test=False).search([])
        by_key = {match_key(employee.name): employee for employee in employees}
        groups = {clean(group.name): group
                  for group in Group.with_context(active_test=False).search([])}

        plan = {'sheets': [], 'count': len(rows), 'skipped': skipped,
                'changed': [], 'new': [], 'stop': [], 'same': [],
                'untouched': [], 'new_groups': [], 'archive': [], 'revive': []}
        seen = set()
        for row in rows:
            if row['sheet'] not in plan['sheets']:
                plan['sheets'].append(row['sheet'])
            group = groups.get(row['sheet'])
            if not group and row['sheet'] not in plan['new_groups']:
                plan['new_groups'].append(row['sheet'])
            values = self._excel_card_values(row)
            values['group_id'] = group.id if group else False

            # الاسم المختلف شخصٌ مختلف: لا مطابقة تقريبية، إنما الاسم
            # نفسه بعد تجاهل الهمزات والتطويل والفراغات
            employee = by_key.get(match_key(row['name']))
            if not employee:
                plan['new'].append({
                    'name': row['name'], 'sheet': row['sheet'],
                    'gross': row['gross'], 'net': row['net'],
                    'method': METHODS[values['payment_method']],
                    'values': dict(values, name=row['name']),
                })
                continue
            seen.add(match_key(employee.name))
            fields = []
            for name, label in COMPARED:
                if name not in values:
                    continue
                new = values[name]
                old = employee[name]
                if name == 'group_id':
                    old = old.id or False
                    if old == new:
                        continue
                    fields.append({'label': label,
                                   'old': employee.group_id.name or 'بلا كشف',
                                   'new': row['sheet']})
                elif isinstance(new, bool):
                    if bool(old) == new:
                        continue
                    fields.append({'label': label,
                                   'old': 'نعم' if old else 'لا',
                                   'new': 'نعم' if new else 'لا'})
                elif isinstance(new, float):
                    if abs((old or 0.0) - new) < 0.0005:
                        continue
                    fields.append({'label': label, 'old': '%.3f' % (old or 0.0),
                                   'new': '%.3f' % new})
                else:
                    if (old or '') == new:
                        continue
                    fields.append({'label': label,
                                   'old': METHODS.get(old, old or '—'),
                                   'new': METHODS.get(new, new)})
            item = {'id': employee.id, 'name': employee.name,
                    'file_name': row['name'], 'near': '',
                    'sheet': row['sheet'], 'fields': fields, 'values': values}
            if fields:
                plan['changed'].append(item)
            else:
                plan['same'].append({'name': employee.name, 'sheet': row['sheet']})

        # الإيقاف لا يتعدّى كشوف الملف: من كان كشفه غائباً عن الملف لا يُمسّ،
        # فرفع ملف مشروعٍ واحدٍ لا يوقف موظفي المكتب
        for employee in employees:
            if not employee.active or match_key(employee.name) in seen:
                continue
            if clean(employee.group_id.name) not in plan['sheets']:
                plan['untouched'].append({'name': employee.name,
                                          'sheet': employee.group_id.name or 'بلا كشف'})
                continue
            plan['stop'].append({'id': employee.id, 'name': employee.name,
                                 'sheet': employee.group_id.name or 'بلا كشف'})

        # الكشف الغائب عن الملف: مشروعٌ انتهى، فيُرشَّح للأرشفة ومعه من
        # بقي على رأس عمله فيه. والمؤرشف الذي عاد في الملف يعود معه.
        stopping = {item['id'] for item in plan['stop']}
        for group in Group.with_context(active_test=False).search([]):
            name = clean(group.name)
            if name in plan['sheets']:
                if not group.active:
                    plan['revive'].append({'id': group.id, 'name': group.name})
                continue
            if not group.active:
                continue
            on_duty = [employee for employee in group.employee_ids
                       if employee.active and employee.id not in stopping]
            plan['archive'].append({
                'id': group.id, 'name': group.name,
                'count': len(on_duty),
                'employees': [employee.id for employee in on_duty],
                'names': [employee.name for employee in on_duty],
            })
        return plan

    @api.model
    def preview_excel(self, content):
        """يُقرأ الملف ويُقارن بالبطاقات، ولا يُكتب شيء."""
        plan = self._excel_plan(content)
        light = dict(plan)
        light['changed'] = [{key: value for key, value in item.items()
                             if key != 'values'} for item in plan['changed']]
        light['new'] = [{key: value for key, value in item.items()
                         if key != 'values'} for item in plan['new']]
        light['archive'] = [{key: value for key, value in item.items()
                             if key != 'employees'} for item in plan['archive']]
        return light

    @api.model
    def apply_excel(self, content, options=None):
        """يطبّق الخطة على البطاقات: تعديلاً وإضافةً وإيقافاً."""
        options = options or {}
        plan = self._excel_plan(content)
        Group = self.env['myaccounting.payroll.group']
        created_groups = []
        if options.get('add', True) or options.get('edit', True):
            for name in plan['new_groups']:
                group = Group.create({'name': name,
                                      'sequence': 10 * (Group.search_count([]) + 1)})
                created_groups.append(group.name)
                # الكشف استجدّ، فنُصلح إشارات الخطة إليه
                for item in plan['changed'] + plan['new']:
                    if item['sheet'] == name:
                        item['values']['group_id'] = group.id

        edited = added = stopped = 0
        if options.get('edit', True):
            for item in plan['changed']:
                self.browse(item['id']).write(item['values'])
                edited += 1
        if options.get('add', True):
            sequence = max(self.with_context(active_test=False).search([])
                           .mapped('sequence') or [0])
            for item in plan['new']:
                sequence += 10
                self.create(dict(item['values'], sequence=sequence))
                added += 1
        if options.get('stop', True):
            for item in plan['stop']:
                self.browse(item['id']).write({'active': False})
                stopped += 1
        # الكشف الغائب عن الملف يُؤرشف بطلبٍ صريح، لأن الملف قد يكون
        # جزئياً. ومن بقي على رأس عمله فيه يُوقَف معه.
        Group = self.env['myaccounting.payroll.group']
        archived = []
        if options.get('archive'):
            for item in plan['archive']:
                self.browse(item['employees']).write({'active': False})
                stopped += len(item['employees'])
                Group.browse(item['id']).write({'active': False})
                archived.append(item['name'])
        revived = [item['name'] for item in plan['revive']]
        if revived:
            Group.with_context(active_test=False).browse(
                [item['id'] for item in plan['revive']]).write({'active': True})
        return {'edited': edited, 'added': added, 'stopped': stopped,
                'groups': created_groups, 'archived': archived,
                'revived': revived, 'employees': self.get_employees()}
