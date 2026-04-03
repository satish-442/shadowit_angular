import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

export interface StatsResponse {
  phase: string;
  found: number;
  review: number;
  notfound: number;
}

export interface ChartDataResponse {
  compliant: number;
  shadowit: number;
  review: number;
  exact_count: number;
  ai_count: number;
  manual_count?: number;
  method_labels?: string[];
}

export interface ResultItem {
  package_name: string;
  publisher: string;
  status: string;
  match_method: string;
  cmdb_match: string;
  manufacturer: string;
  ai_processed?: boolean;
  application_id?: string;
  reasoning?: string;
}

export interface ResultsResponse {
  data: ResultItem[];
  total: number;
  page: number;
  limit: number;
  total_pages: number;
}

export interface KpiResponse {
  total_packages?: number;
  total_cmdb?: number;
  compliant_matches?: number;
  review_matches?: number;
  shadow_it?: number;
  ai_processed?: number;
  match_rate?: number;
  unmatched_rate?: number;
  review_rate?: number;
  in_sam_not_cmdb?: number;
  in_cmdb_not_sam?: number;
  unique_cmdb_matched?: number;
  cmdb_coverage?: number;
  ai_effectiveness?: number;
  exact_matches?: number;
  ai_matches?: number;
  cmdb_owner_rate?: number;
}

export interface UiAuditPayload {
  event: string;
  context?: Record<string, unknown>;
}

export interface BulkRecord {
  raw_name: string;
  raw_pub: string;
}

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly base = environment.apiUrl;

  constructor(private http: HttpClient) {}

  startProcessing(): Observable<{ message: string; phase?: string; already_running?: boolean }> {
    return this.http.post<{ message: string; phase?: string; already_running?: boolean }>(`${this.base}/start`, {});
  }

  runAiAnalysis(status: string): Observable<{ message: string }> {
    return this.http.post<{ message: string }>(`${this.base}/analyze`, { status });
  }

  runShadowITCleanup(): Observable<{ message: string }> {
    return this.http.post<{ message: string }>(`${this.base}/cleanup-shadow-it`, {});
  }

  getStats(): Observable<StatsResponse> {
    return this.http.get<StatsResponse>(`${this.base}/stats`);
  }

  getChartData(): Observable<ChartDataResponse> {
    return this.http.get<ChartDataResponse>(`${this.base}/chart-data`);
  }

  getKpi(): Observable<KpiResponse> {
    return this.http.get<KpiResponse>(`${this.base}/kpi`);
  }

  getResults(
    page = 1,
    limit = 50,
    status = 'ALL',
    method = 'ALL',
    search = '',
    sort = 'raw_name',
    dir: 'ASC' | 'DESC' = 'ASC',
    aiOnly = false
  ): Observable<ResultsResponse> {
    let params = new HttpParams()
      .set('page', String(page))
      .set('limit', String(limit))
      .set('status', status)
      .set('method', method)
      .set('sort', sort)
      .set('dir', dir);

    if (search.trim()) {
      params = params.set('search', search.trim());
    }

    if (aiOnly) {
      params = params.set('ai_only', 'true');
    }

    return this.http.get<ResultsResponse>(`${this.base}/results`, { params });
  }

  exportResults(status = 'ALL'): void {
    window.open(`${this.base}/export?status=${status}`, '_blank');
  }

  auditUiEvent(payload: UiAuditPayload): Observable<{ message: string }> {
    return this.http.post<{ message: string }>(`${this.base}/audit-ui-event`, payload);
  }

  bulkUpdateStatus(
    records: BulkRecord[],
    status: 'Compliant' | 'REVIEW' | 'Shadow IT'
  ): Observable<{ count: number; message: string }> {
    return this.http.post<{ count: number; message: string }>(`${this.base}/bulk-update`, {
      records,
      status,
    });
  }
}
