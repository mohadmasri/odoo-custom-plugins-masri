import io
import json

import xlsxwriter

from odoo import fields, http
from odoo.http import request


class BackupController(http.Controller):

    @http.route('/my_accounting/backup/download', type='http', auth='user')
    def download_backup(self, **kwargs):
        data = request.env['myaccounting.backup'].get_backup_data()
        content = json.dumps(data, ensure_ascii=False, indent=2).encode('utf-8')
        filename = 'my_accounting_backup_%s.json' % data['exported_at'][:10]
        return request.make_response(
            content,
            headers=[
                ('Content-Type', 'application/json; charset=utf-8'),
                ('Content-Disposition', f'attachment; filename="{filename}"'),
            ],
        )


class JournalImportController(http.Controller):

    @http.route('/my_accounting/journal_import/template', type='http', auth='user')
    def download_import_template(self, **kwargs):
        """يولّد قالب Excel جاهزاً لتعبئته باستيراد قيود متعدّدة."""
        content = request.env['myaccounting.move'].build_import_template_xlsx()
        return request.make_response(
            content,
            headers=[
                ('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
                ('Content-Disposition', 'attachment; filename="journal_entries_template.xlsx"'),
            ],
        )


class GeneralLedgerController(http.Controller):

    @http.route('/my_accounting/general_ledger/xlsx', type='http', auth='user')
    def export_general_ledger_xlsx(self, year=None, month=None, **kwargs):
        data = request.env['myaccounting.move'].get_general_ledger_matrix(year, month)
        accounts = data['accounts']

        output = io.BytesIO()
        workbook = xlsxwriter.Workbook(output, {'in_memory': True})
        sheet = workbook.add_worksheet('دفتر الأستاذ العام')
        sheet.right_to_left()

        header_fmt = workbook.add_format({'bold': True, 'bg_color': '#f2f2f2', 'border': 1, 'text_wrap': True})
        total_fmt = workbook.add_format({'bold': True, 'bg_color': '#f2f2f2', 'border': 1, 'num_format': '#,##0.000'})
        num_fmt = workbook.add_format({'border': 1, 'num_format': '#,##0.000'})
        text_fmt = workbook.add_format({'border': 1})

        headers = ['#', 'القيد', 'التاريخ', 'المرجع', 'إجمالي مدين', 'إجمالي دائن']
        for acc in accounts:
            headers.append(f"{acc['code']} - {acc['name']} (مدين)")
            headers.append(f"{acc['code']} - {acc['name']} (دائن)")
        for c, h in enumerate(headers):
            sheet.write(0, c, h, header_fmt)

        row_idx = 1
        for row in data['rows']:
            col = 0
            sheet.write(row_idx, col, row['seq'], text_fmt); col += 1
            sheet.write(row_idx, col, row['move_name'], text_fmt); col += 1
            sheet.write(row_idx, col, row['date'] or '', text_fmt); col += 1
            sheet.write(row_idx, col, row['ref'] or '', text_fmt); col += 1
            sheet.write(row_idx, col, row['total_debit'], num_fmt); col += 1
            sheet.write(row_idx, col, row['total_credit'], num_fmt); col += 1
            for acc in accounts:
                amt = row['amounts'].get(acc['id'])
                sheet.write(row_idx, col, amt['debit'] if amt else '', num_fmt); col += 1
                sheet.write(row_idx, col, amt['credit'] if amt else '', num_fmt); col += 1
            row_idx += 1

        col = 0
        sheet.write(row_idx, col, 'الإجمالي', header_fmt); col += 1
        sheet.write(row_idx, col, '', header_fmt); col += 1
        sheet.write(row_idx, col, '', header_fmt); col += 1
        sheet.write(row_idx, col, '', header_fmt); col += 1
        sheet.write(row_idx, col, data['grand_debit'], total_fmt); col += 1
        sheet.write(row_idx, col, data['grand_credit'], total_fmt); col += 1
        for acc in accounts:
            t = data['totals'].get(acc['id'], {'debit': 0, 'credit': 0})
            sheet.write(row_idx, col, t['debit'], total_fmt); col += 1
            sheet.write(row_idx, col, t['credit'], total_fmt); col += 1

        sheet.set_column(0, 0, 6)
        sheet.set_column(1, 3, 14)
        sheet.set_column(4, 4 + 1 + len(accounts) * 2, 13)

        workbook.close()
        output.seek(0)
        filename = f"general_ledger_{year}_{int(month):02d}.xlsx"
        return request.make_response(
            output.read(),
            headers=[
                ('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
                ('Content-Disposition', f'attachment; filename="{filename}"'),
            ],
        )
