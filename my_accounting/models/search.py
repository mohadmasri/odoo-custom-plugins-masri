"""البحث العام: شريط واحد يبحث في كل شيء بنصّ واحد.

يُقسَّم النص إلى كلمات ويُطلب أن تَرِد كلها، بأي ترتيب وبينها ما بينها،
فـ"كفالة 85" يجد "كفالة رقم 85/26 دخول عطاء وزارة الزراعة". ويتسامح مع
صور الحروف (كفالة/كفاله) وشكل الأرقام (290/٢٩٠)، ويفهم الرقم رقمَ قيد
ورمزَ حساب ومبلغاً معاً.
"""
import re

from odoo import api, fields, models

from .payroll import MONTH_LABELS

ARABIC_TO_LATIN = str.maketrans('٠١٢٣٤٥٦٧٨٩', '0123456789')
LATIN_TO_ARABIC = str.maketrans('0123456789', '٠١٢٣٤٥٦٧٨٩')
AMOUNT_RE = re.compile(r'^\d+(\.\d+)?$')
# حروف تُكتب بصور متعددة: نضع مكانها محرف "أي حرف واحد" في نمط البحث
VARIANTS = 'اأإآٱةهىيئؤو'
TOKEN_SPLIT_RE = re.compile(r'\s+')


def to_latin(text):
    return (text or '').translate(ARABIC_TO_LATIN)


def _fuzzy(token):
    """نمط ILIKE متسامح: كل حرف متعدد الصور يصير "أي حرف واحد"."""
    out = []
    for char in token:
        if char in VARIANTS:
            out.append('_')
        elif char in '%_\\':
            out.append('\\' + char)
        else:
            out.append(char)
    return '%' + ''.join(out) + '%'


def token_patterns(token):
    """صيغ البحث عن كلمة واحدة: كما كُتبت، وبالأرقام العربية، وبالإنجليزية."""
    forms = {token, token.translate(ARABIC_TO_LATIN), token.translate(LATIN_TO_ARABIC)}
    return [_fuzzy(form) for form in forms if form]


def canon(text):
    """صورة واحدة للنص: أرقامٌ لاتينية وهمزاتٌ وتاءٌ مبسوطة."""
    text = to_latin(text or '').casefold()
    for bad, good in (('أ', 'ا'), ('إ', 'ا'), ('آ', 'ا'), ('ٱ', 'ا'),
                      ('ى', 'ي'), ('ة', 'ه'), ('ـ', '')):
        text = text.replace(bad, good)
    return text


def holds(text, tokens):
    """النص يحوي كلمات الطلب كلها (بأي ترتيب)."""
    body = canon(text)
    return all(canon(token) in body for token in tokens)


def split_tokens(query):
    return [part for part in TOKEN_SPLIT_RE.split((query or '').strip()) if part]


def tokens_domain(tokens, fields_names):
    """كل كلمة يجب أن ترد في أحد الحقول؛ والكلمات مجتمعة بـ"و"."""
    domain = []
    for token in tokens:
        leaves = [(name, 'ilike', pattern)
                  for pattern in token_patterns(token)
                  for name in fields_names]
        if not leaves:
            continue
        domain += ['|'] * (len(leaves) - 1) + leaves
    return domain


class MyAccountingSearch(models.AbstractModel):
    _name = 'myaccounting.search'
    _description = 'البحث العام'

    @api.model
    def _rank(self, tokens, *values):
        """0 مطابقة تامة لكلمة، 1 بداية كلمة، 2 ورودها داخل النص."""
        best = 3
        for value in values:
            text = to_latin(value or '').casefold()
            if not text:
                continue
            for token in tokens:
                needle = to_latin(token).casefold()
                if text == needle:
                    return 0
                if text.startswith(needle):
                    best = min(best, 1)
                elif needle in text:
                    best = min(best, 2)
        return best


    # ------------------------------------------------------------------
    # الفلاتر: تُطبَّق فوق النص لا بدلاً منه
    # ------------------------------------------------------------------

    @api.model
    def search_options(self):
        """خيارات الفلاتر الجاهزة للواجهة."""
        Move = self.env['myaccounting.move']
        accounts = self.env['myaccounting.account'].search([], order='code_path')
        return {
            'years': Move.get_ledger_years(),
            'journals': self.env['myaccounting.journal'].get_journal_names(),
            'states': [('posted', 'مرحّل'), ('draft', 'مسودة'), ('incomplete', 'غير مكتمل')],
            'kinds': [('moves', 'القيود والسندات'), ('accounts', 'الحسابات'),
                      ('lines', 'بنود القيود'), ('payroll', 'الرواتب')],
            'accounts': [{'id': acc.id, 'label': f'{acc.code} - {acc.name}' if acc.code
                          else acc.name} for acc in accounts],
        }

    @api.model
    def _amount_bounds(self, filters):
        def number(key):
            value = filters.get(key)
            if value in (None, '', False):
                return None
            try:
                return float(value)
            except (TypeError, ValueError):
                return None
        return number('amount_min'), number('amount_max')

    @api.model
    def _move_filter_domain(self, filters, prefix=''):
        """شروط الفلاتر على القيد. prefix للوصول إليه من البند."""
        domain = []
        if filters.get('year'):
            domain.append((prefix + 'ledger_year', '=', int(filters['year'])))
        if filters.get('month'):
            domain.append((prefix + 'ledger_month', '=', str(filters['month'])))
        if filters.get('states'):
            domain.append((prefix + 'state', 'in', list(filters['states'])))
        if filters.get('journal'):
            domain.append((prefix + 'journal', 'ilike', filters['journal']))
        return domain

    @api.model
    def _has_record_filters(self, filters):
        """فلاتر لا معنى لها على الحسابات، فوجودها يُخرج مجموعة الحسابات."""
        low, high = self._amount_bounds(filters)
        return bool(filters.get('year') or filters.get('month') or filters.get('states')
                    or filters.get('journal') or filters.get('account_id')
                    or low is not None or high is not None)

    # ------------------------------------------------------------------

    @api.model
    def _move_items(self, tokens, limit, filters):
        Move = self.env['myaccounting.move']
        domain = tokens_domain(tokens, ['name', 'ref', 'journal'])
        domain += self._move_filter_domain(filters)
        if filters.get('account_id'):
            domain.append(('line_ids.account_id', 'child_of', int(filters['account_id'])))
        low, high = self._amount_bounds(filters)
        if low is not None:
            domain.append(('total_debit', '>=', low))
        if high is not None:
            domain.append(('total_debit', '<=', high))
        moves = Move.search(domain, limit=limit * 4, order='sort_key desc')
        items = []
        for move in moves:
            receipt = move.move_type == 'receipt'
            items.append({
                'kind': 'receipt' if receipt else 'move',
                'kind_label': 'سند قبض' if receipt else 'قيد',
                'icon': 'fa-money' if receipt else 'fa-file-text-o',
                'model': 'myaccounting.move',
                'id': move.id,
                'title': move.name or '—',
                'subtitle': move.ref or '',
                'extra': f'{move.ledger_period_label or ""} · {move.journal or ""}'.strip(' ·'),
                'amount': move.total_debit,
                'rank': self._rank(tokens, move.name, move.ref, move.journal),
            })
        return items

    @api.model
    def _account_items(self, tokens, limit, filters):
        Account = self.env['myaccounting.account']
        domain = tokens_domain(tokens, ['code', 'name'])
        if filters.get('account_id'):
            domain.append(('id', 'child_of', int(filters['account_id'])))
        accounts = Account.search(domain, limit=limit * 4, order='code_path')
        return [{
            'kind': 'account',
            'kind_label': 'حساب',
            'icon': 'fa-sitemap',
            'model': 'myaccounting.account',
            'id': account.id,
            'title': f'{account.code} - {account.name}' if account.code else account.name,
            'subtitle': account.parent_id.name or '',
            'extra': '',
            'amount': 0.0,
            'rank': self._rank(tokens, account.code, account.name),
        } for account in accounts]

    @api.model
    def _line_items(self, tokens, limit, query, filters):
        """بنود القيود: يُفتح قيدها، فالبند وحده لا معنى له."""
        Line = self.env['myaccounting.move.line']
        domain = tokens_domain(tokens, ['name'])
        amount = to_latin(query).strip()
        if AMOUNT_RE.match(amount):
            # رقم مجرّد: نبحث عنه مبلغاً أيضاً، لا نصّاً فقط
            value = float(amount)
            domain = ['|', '|', ('debit', '=', value), ('credit', '=', value)] + domain
        domain += self._move_filter_domain(filters, prefix='move_id.')
        if filters.get('account_id'):
            domain.append(('account_id', 'child_of', int(filters['account_id'])))
        low, high = self._amount_bounds(filters)
        lines = Line.search(domain, limit=limit * 8, order='move_sort_key desc, id desc')
        items = []
        seen = set()
        for line in lines:
            # مبلغ البند هو المدين أو الدائن أيّهما كُتب
            value = line.debit or line.credit
            if (low is not None and value < low) or (high is not None and value > high):
                continue
            key = (line.move_id.id, (line.name or '').strip())
            if key in seen:
                continue
            seen.add(key)
            items.append({
                'kind': 'line',
                'kind_label': 'بند',
                'icon': 'fa-list',
                'model': 'myaccounting.move',
                'id': line.move_id.id,
                'title': line.name or '—',
                'subtitle': f'{line.move_id.name or ""} · {line.account_id.name or ""}'.strip(' ·'),
                'extra': fields.Date.to_string(line.date) if line.date else '',
                'amount': line.debit or line.credit,
                'rank': self._rank(tokens, line.name),
            })
        return items

    # ------------------------------------------------------------------
    # الرواتب: الموظف وكشف مشروعه وكشف الشهر، تُفتح في صفحة الرواتب
    # ------------------------------------------------------------------

    @api.model
    def _employee_items(self, tokens, limit, filters):
        """بطاقات الموظفين. وفلاتر القيود لا تخصّها، فوجودها يُخرجها."""
        if self._has_record_filters(filters) or not tokens:
            return []
        Employee = self.env['myaccounting.employee']
        domain = tokens_domain(
            tokens, ['name', 'job_title', 'national_id', 'social_number', 'phone'])
        employees = Employee.with_context(active_test=False).search(
            domain, limit=limit * 4)
        items = []
        for employee in employees:
            data = employee._payload()
            sheet = employee.group_id.name or 'بلا كشف'
            items.append({
                'kind': 'employee',
                'kind_label': 'موظف',
                'icon': 'fa-id-card-o',
                'model': 'myaccounting.employee',
                'id': employee.id,
                'action': 'payroll',
                'payroll': {'kind': 'employee', 'id': employee.id},
                'title': employee.name or '—',
                'subtitle': employee.job_title or '',
                'extra': 'كشف %s%s' % (sheet,
                                       '' if employee.active else ' · موقوف'),
                'amount': data['net'],
                'rank': self._rank(tokens, employee.name, employee.job_title),
            })
        return items

    @api.model
    def _payroll_items(self, tokens, limit, filters):
        """كشوف المشاريع وكشوف الأشهر.

        الكشف يُطلب باسمه وحده أو مسبوقاً بـ«رواتب» أو «كشف» أو
        «مشروع»، فيُقابَل الطلب بنصٍّ مركّبٍ لا بالاسم المجرّد.
        """
        if self._has_record_filters(filters) or not tokens:
            return []
        Line = self.env['myaccounting.payroll.line']
        items = []
        groups = self.env['myaccounting.payroll.group'].with_context(
            active_test=False).search([])
        for group in groups:
            if not holds('كشف رواتب مشروع %s' % (group.name or ''), tokens):
                continue
            lines = Line.search([('group_id', '=', group.id)])
            months = {(line.payroll_id.year, line.payroll_id.month)
                      for line in lines}
            items.append({
                'kind': 'payroll_group',
                'kind_label': 'كشف مشروع',
                'icon': 'fa-folder-o',
                'model': 'myaccounting.payroll.group',
                'id': group.id,
                'action': 'payroll',
                'payroll': {'kind': 'project', 'id': group.id,
                            'active': group.active},
                'title': 'رواتب %s' % (group.name or ''),
                'subtitle': '%d موظفاً · %d كشفاً' % (
                    len(group.with_context(active_test=False).employee_ids),
                    len(months)),
                'extra': 'قائم' if group.active else 'منتهٍ',
                'amount': round(sum(line.basic_salary + line.allowance
                                    for line in lines), 3),
                'rank': self._rank(tokens, group.name),
            })
        payrolls = self.env['myaccounting.payroll'].search([])
        for payroll in payrolls:
            text = '%s %s %s' % (payroll.name or '',
                                 MONTH_LABELS.get(payroll.month, ''), payroll.year)
            if not holds(text, tokens):
                continue
            items.append({
                'kind': 'payroll_month',
                'kind_label': 'كشف شهر',
                'icon': 'fa-calendar',
                'model': 'myaccounting.payroll',
                'id': payroll.id,
                'action': 'payroll',
                'payroll': {'kind': 'month', 'year': payroll.year,
                            'month': payroll.month},
                'title': payroll.name or '—',
                'subtitle': '%s %s' % (MONTH_LABELS.get(payroll.month, ''),
                                       payroll.year),
                'extra': '%d بنداً' % len(payroll.line_ids),
                'amount': round(sum(line.basic_salary + line.allowance
                                    for line in payroll.line_ids), 3),
                'rank': self._rank(tokens, payroll.name),
            })
        return items

    # ------------------------------------------------------------------

    @api.model
    def search_all(self, query, limit=6, filters=None):
        """نتائج مجمّعة حسب النوع، لكل نوع أهمّ نتائجه.

        الفلاتر تضيق النتائج فوق النص. ومع وجود فلتر واحد على الأقل
        يجوز أن يكون النص فارغاً، فيصير البحث تصفّحاً بالفلاتر.
        """
        filters = filters or {}
        query = (query or '').strip()
        tokens = split_tokens(query)
        has_filters = self._has_record_filters(filters)
        if (not tokens or len(query) < 2) and not has_filters:
            return {'query': query, 'groups': [], 'total': 0}
        limit = max(1, int(limit))
        kinds = list(filters.get('kinds')
                     or ['moves', 'accounts', 'lines', 'payroll'])
        groups = []
        total = 0
        sources = []
        if 'moves' in kinds:
            sources.append(('القيود والسندات', self._move_items(tokens, limit, filters)))
        # الحسابات لا فترة لها ولا حالة، فتُخفى متى ضُيّق البحث بما لا يخصّها
        if 'accounts' in kinds and not has_filters:
            sources.append(('الحسابات', self._account_items(tokens, limit, filters)))
        elif 'accounts' in kinds and filters.get('account_id') and not any(
                filters.get(key) for key in ('year', 'month', 'states', 'journal')):
            sources.append(('الحسابات', self._account_items(tokens, limit, filters)))
        # الرواتب قبل بنود القيود: نتائجها قليلةٌ دقيقة، والبنود كثيرة
        if 'payroll' in kinds:
            sources.append(('الموظفون', self._employee_items(tokens, limit, filters)))
            sources.append(('كشوف الرواتب', self._payroll_items(tokens, limit, filters)))
        if 'lines' in kinds:
            sources.append(('بنود القيود', self._line_items(tokens, limit, query, filters)))
        for label, items in sources:
            items.sort(key=lambda item: (item['rank'], item['title']))
            total += len(items)
            if items:
                groups.append({'label': label, 'items': items[:limit],
                               'more': max(0, len(items) - limit)})
        return {'query': query, 'groups': groups, 'total': total}
