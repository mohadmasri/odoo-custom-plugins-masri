from odoo import api, models
from odoo.exceptions import UserError


# تعريف "التطبيقات" القابلة للتحكم بصلاحياتها من صفحة إدارة المستخدمين، مع
# مجموعتي "عرض" و"تعديل" الخاصة بكل تطبيق. التطبيقات التي لا تملك أصلاً مستويين
# منفصلين في أودو (مثل المناقشة أو التقويم) تُستخدم فيها نفس المجموعة للعرض
# والتعديل، لأن الفارق بينهما غير موجود فعلياً في هذا الإصدار.
APP_DEFINITIONS = [
    {'key': 'myaccounting', 'label': 'المحاسبة المخصصة',
     'view_group': 'my_accounting.group_myaccounting_view',
     'edit_group': 'my_accounting.group_myaccounting_edit', 'tiered': True},
    {'key': 'project', 'label': 'المشروع',
     'view_group': 'project.group_project_user',
     'edit_group': 'project.group_project_manager', 'tiered': True},
    {'key': 'invoicing', 'label': 'الفوترة',
     'view_group': 'account.group_account_invoice',
     'edit_group': 'account.group_account_manager', 'tiered': True},
    {'key': 'dashboard', 'label': 'لوحات البيانات',
     'view_group': 'my_accounting.group_app_dashboard_view',
     'edit_group': 'spreadsheet_dashboard.group_dashboard_manager', 'tiered': True},
    {'key': 'discuss', 'label': 'المناقشة',
     'view_group': 'my_accounting.group_app_discuss',
     'edit_group': 'my_accounting.group_app_discuss', 'tiered': False},
    {'key': 'calendar', 'label': 'التقويم',
     'view_group': 'my_accounting.group_app_calendar',
     'edit_group': 'my_accounting.group_app_calendar', 'tiered': False},
    {'key': 'todo', 'label': 'المهام',
     'view_group': 'my_accounting.group_app_todo',
     'edit_group': 'my_accounting.group_app_todo', 'tiered': False},
    {'key': 'contacts', 'label': 'جهات الاتصال',
     'view_group': 'my_accounting.group_app_contacts',
     'edit_group': 'my_accounting.group_app_contacts', 'tiered': False},
]


class MyAccountingUserAdmin(models.AbstractModel):
    _name = 'myaccounting.user_admin'
    _description = 'إدارة مستخدمي النظام'

    def _check_admin(self):
        if not self.env.user.has_group('base.group_system'):
            raise UserError('هذه الصفحة مخصصة للمسؤول (Administrator) فقط.')

    @api.model
    def get_users(self):
        self._check_admin()
        users = self.env['res.users'].search([
            ('share', '=', False),
            ('active', '=', True),
        ], order='login')
        return [{
            'id': u.id,
            'login': u.login,
            'is_admin': u.has_group('base.group_system'),
            'is_self': u.id == self.env.user.id,
        } for u in users]

    @api.model
    def create_user(self, login, password):
        self._check_admin()
        login = (login or '').strip()
        password = password or ''
        if not login:
            raise UserError('اسم المستخدم مطلوب.')
        if len(password) < 4:
            raise UserError('كلمة المرور يجب أن تكون 4 محارف على الأقل.')
        if self.env['res.users'].sudo().search_count([('login', '=', login)]):
            raise UserError('اسم المستخدم هذا مستخدم بالفعل.')
        user = self.env['res.users'].create({
            'name': login,
            'login': login,
            'password': password,
            'group_ids': [(6, 0, [self.env.ref('base.group_user').id])],
        })
        return {'id': user.id}

    @api.model
    def rename_user(self, user_id, login):
        self._check_admin()
        login = (login or '').strip()
        if not login:
            raise UserError('اسم المستخدم مطلوب.')
        user = self.env['res.users'].browse(user_id)
        if self.env['res.users'].sudo().search_count([('login', '=', login), ('id', '!=', user.id)]):
            raise UserError('اسم المستخدم هذا مستخدم بالفعل.')
        user.write({'login': login, 'name': login})

    @api.model
    def set_user_password(self, user_id, password):
        self._check_admin()
        if len(password or '') < 4:
            raise UserError('كلمة المرور يجب أن تكون 4 محارف على الأقل.')
        self.env['res.users'].browse(user_id).write({'password': password})

    @api.model
    def delete_user(self, user_id):
        self._check_admin()
        user = self.env['res.users'].browse(user_id)
        if user.id == self.env.user.id:
            raise UserError('لا يمكنك حذف حسابك الخاص.')
        if user.has_group('base.group_system'):
            raise UserError('لا يمكن حذف مستخدم لديه صلاحيات مسؤول من هذه الصفحة.')
        user.unlink()

    @api.model
    def get_apps_matrix(self, user_id):
        self._check_admin()
        user = self.env['res.users'].browse(user_id)
        user_group_ids = set(user.group_ids.ids)
        result = []
        for app in APP_DEFINITIONS:
            view_group = self.env.ref(app['view_group'], raise_if_not_found=False)
            edit_group = self.env.ref(app['edit_group'], raise_if_not_found=False)
            has_edit = bool(edit_group and edit_group.id in user_group_ids)
            has_view = has_edit or bool(view_group and view_group.id in user_group_ids)
            level = 'edit' if has_edit else ('view' if has_view else 'none')
            result.append({
                'key': app['key'],
                'label': app['label'],
                'tiered': app['tiered'],
                'level': level,
            })
        return result

    @api.model
    def set_app_permission(self, user_id, app_key, level):
        self._check_admin()
        if level not in ('none', 'view', 'edit'):
            raise UserError('مستوى صلاحية غير صالح.')
        app = next((a for a in APP_DEFINITIONS if a['key'] == app_key), None)
        if not app:
            raise UserError('تطبيق غير معروف.')
        user = self.env['res.users'].browse(user_id)
        view_group = self.env.ref(app['view_group'], raise_if_not_found=False)
        edit_group = self.env.ref(app['edit_group'], raise_if_not_found=False)
        to_remove = [g.id for g in (view_group, edit_group) if g]
        commands = [(3, gid) for gid in to_remove]
        if level == 'view' and view_group:
            commands.append((4, view_group.id))
        elif level == 'edit' and edit_group:
            commands.append((4, edit_group.id))
        if commands:
            user.write({'group_ids': commands})
