import { Component, Input } from '@angular/core';
import { KpiResponse } from '../../../core/services/api.service';

@Component({
  selector: 'app-kpi-cards',
  standalone: false,
  templateUrl: './kpi-cards.component.html',
})
export class KpiCardsComponent {
  @Input() kpi: KpiResponse = {} as KpiResponse;
  @Input() isDashboardLoading = true;

  get kpiMatchRate(): string {
    return `${this.toPercent(this.kpi?.match_rate)}%`;
  }

  get kpiUnmatchedRate(): string {
    return `${this.toPercent(this.kpi?.unmatched_rate)}%`;
  }

  get kpiReviewRate(): string {
    return `${this.toPercent(this.kpi?.review_rate)}%`;
  }

  get kpiAiEffectiveness(): string {
    return `${this.toPercent(this.kpi?.ai_effectiveness)}%`;
  }

  get kpiTotalPackages(): number {
    return this.toNumber(this.kpi?.total_packages);
  }

  get kpiTotalCmdb(): number {
    return this.toNumber(this.kpi?.total_cmdb);
  }

  get kpiSamNotCmdb(): number {
    return this.toNumber(this.kpi?.shadow_it ?? this.kpi?.in_sam_not_cmdb);
  }

  get kpiCmdbNotSam(): number {
    if (this.kpi?.in_cmdb_not_sam != null) return this.toNumber(this.kpi.in_cmdb_not_sam);
    return Math.max(0, this.kpiTotalCmdb - this.toNumber(this.kpi?.unique_cmdb_matched));
  }

  get kpiAiProcessed(): number {
    return this.toNumber(this.kpi?.ai_processed);
  }

  get kpiAiSuccessRate(): string {
    const processed = this.toNumber(this.kpi?.ai_processed);
    const matches = this.toNumber(this.kpi?.ai_matches);
    return `${this.toPercent(processed > 0 ? (matches / processed) * 100 : 0)}%`;
  }

  get kpiPendingReview(): number {
    return this.toNumber(this.kpi?.review_matches);
  }

  get kpiAutomationRate(): string {
    const compliant = this.toNumber(this.kpi?.compliant_matches);
    const exact = this.toNumber(this.kpi?.exact_matches);
    const ai = this.toNumber(this.kpi?.ai_matches);
    return `${this.toPercent(compliant > 0 ? ((exact + ai) / compliant) * 100 : 0)}%`;
  }

  get kpiCmdbCoverage(): string {
    return `${this.toPercent(this.kpi?.cmdb_coverage)}%`;
  }

  private toNumber(value: unknown): number {
    const n = Number(value ?? 0);
    return Number.isFinite(n) ? n : 0;
  }

  private toPercent(value: unknown): string {
    const n = this.toNumber(value);
    return Number.isInteger(n) ? String(n) : n.toFixed(2);
  }
}
