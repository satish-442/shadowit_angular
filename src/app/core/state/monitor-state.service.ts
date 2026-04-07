import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { StatsResponse, KpiResponse, ChartDataResponse, ApiService } from '../services/api.service';

@Injectable({ providedIn: 'root' })
export class MonitorStateService {
  constructor(private api: ApiService) {}

  readonly stats$ = new BehaviorSubject<StatsResponse | null>(null);
  readonly kpi$ = new BehaviorSubject<KpiResponse | null>(null);
  readonly chartData$ = new BehaviorSubject<ChartDataResponse | null>(null);

  /** Emitted when a pipeline completes so the results table knows to refresh */
  readonly pipelineComplete$ = new BehaviorSubject<boolean>(false);

  readonly dataReady$ = new BehaviorSubject<boolean>(false);

  updateDataReady(stats?: StatsResponse | null, kpi?: KpiResponse | null): void {
    if (this.dataReady$.value) return;

    const inventoryLoaded =
      ((stats?.found ?? 0) + (stats?.review ?? 0) + (stats?.notfound ?? 0)) > 0;
    const pipelineIdle = (stats?.phase ?? '').toLowerCase() === 'idle';
    const kpiReady = (kpi?.match_rate ?? 0) > 0 || (kpi?.unmatched_rate ?? 0) > 0;

    if (inventoryLoaded && pipelineIdle && kpiReady) {
      this.dataReady$.next(true);
    }
  }

  resetDataReady(): void {
    this.dataReady$.next(false);
    this.pipelineComplete$.next(false);
  }

  notifyPipelineComplete(): void {
    this.pipelineComplete$.next(true);
  }

  exportResults(status: string): void {
    this.api.exportResults(status);
  }
}
