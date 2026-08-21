import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, tap } from 'rxjs';
import { EXCEL_COLUMN_HEADERS, ExcelRow, Policy } from '../models';
import { API_BASE_URL } from '../config/api.config';

/**
 * Excel generation lives on the server (backend/src/excel/), so the exact
 * 29-column layout, the "policy fields only on the first member row" rule,
 * date formatting, and the text-typed receipt number all have a single
 * definition. This service builds the same rows locally *only* to render the
 * on-screen preview, and downloads the real workbook from the API.
 */
@Injectable({ providedIn: 'root' })
export class ExcelService {
  private readonly http = inject(HttpClient);

  readonly columns = EXCEL_COLUMN_HEADERS;

  /**
   * Preview rows. Mirrors the server's mapper: one row per insured member,
   * with policy-level columns blank on every row after the first.
   */
  toExcelRows(policies: Policy[]): ExcelRow[] {
    const rows: ExcelRow[] = [];
    let sNo = 1;

    for (const policy of policies) {
      const validMembers = policy.members.filter((m) => m?.name?.trim());
      const members = validMembers.length ? validMembers : [null];

      members.forEach((member, index) => {
        const first = index === 0;
        const blank = <T,>(value: T) => (first ? value : ('' as unknown as T));

        rows.push({
          sNo: blank(sNo),
          policyholder: blank(policy.policyHolder.name),
          insuranceCompany: blank(policy.insuranceCompany),
          policyNumber: blank(policy.policyNumber),
          policyStartDate: blank(policy.policyStartDate),
          policyEndDate: blank(policy.policyEndDate),
          policyTenure: blank(policy.policyTenureDays),
          policyReceiptDate: blank(policy.policyReceiptDate),
          sumInsured: blank(policy.premium.sumInsured),
          totalBasicPremium: blank(policy.premium.totalBasicPremium),
          lessFamilyFloaterDiscount: blank(policy.premium.familyFloaterDiscount),
          premium: blank(policy.premium.premium),
          gst: blank(policy.premium.gst),
          totalPremium: blank(policy.premium.totalPremium),
          insuredName: member?.name ?? '',
          relationWithPolicyHolder: member?.relationWithPolicyHolder ?? '',
          age: member?.age ?? ('' as unknown as number),
          gender: member?.gender ?? '',
          occupation: member?.occupation ?? '',
          nomineeName: member?.nomineeName ?? '',
          basePremium: member?.basePremium ?? ('' as unknown as number),
          policyTypeSelfParents: member?.policyTypeSelfParents ?? '',
          policyType: blank(policy.policyType),
          planChosen: blank(policy.planChosen),
          customerId: blank(policy.policyHolder.customerId),
          receiptNumber: blank(policy.receiptNumber),
          newOrRenewalPolicy: blank(policy.newOrRenewal),
          policyholdersAddress: blank(policy.policyHolder.address),
          insuranceCompanyAddress: blank(policy.insuranceCompanyAddress),
        });
      });

      sNo++;
    }

    return rows;
  }

  /** GET /api/policies/export.xlsx — the server builds and streams the workbook. */
  download(policyIds: string[]): Observable<Blob> {
    const query = policyIds.length ? `?ids=${policyIds.join(',')}` : '';
    return this.http
      .get(`${API_BASE_URL}/policies/export.xlsx${query}`, { responseType: 'blob' })
      .pipe(tap((blob) => saveBlob(blob, `insurance-policies-${today()}.xlsx`)));
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}
