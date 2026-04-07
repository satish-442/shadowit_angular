import {
  ChangeDetectorRef, Component, OnDestroy, OnInit, ViewChild
} from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import {
  EMPTY, Subject, catchError, exhaustMap,
  filter, finalize, forkJoin, retry, takeUntil, timer
} from 'rxjs';
import {
  ApiService, ChartDataResponse, KpiResponse, StatsResponse
} from '../../core/services/api.service';
import { MonitorStateService } from '../../core/state/monitor-state.service';
import { ResultsTableComponent } from './results-table/results-table.component';

@Component({
  selector: 'app-dashboard',
  standalone: false,
  templateUrl: './dashboard.component.html',
  styleUrls: ['./dashboard.component.scss'],
})
export class DashboardComponent implements OnInit, OnDestroy {
  @ViewChild(ResultsTableComponent) resultsTable?: ResultsTableComponent;

  currentTab: 'dashboard' | 'table' = 'dashboard';

  stats: StatsResponse = { phase: 'Idle', found: 0, review: 0, notfound: 0 };
  kpi: KpiResponse = {} as KpiResponse;
  chartData: ChartDataResponse = {} as ChartDataResponse;

  isDashboardLoading = true;
  isPipelineStarting = false;
  isAiRunning = false;
  isPollingHealthy = true;
  lastSyncLabel = 'Never';
  error = '';

  private readonly POLL_INTERVAL_MS = 5_000;
  private destroy$ = new Subject<void>();
  private pollFailureCount = 0;
  private statsPollTick = 0;

  constructor(
    private api: ApiService,
    public state: MonitorStateService,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    this.loadInitialState();
    this.startPolling();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  // ─── Computed ──────────────────────────────────────────────────────────────

  get phaseText(): string {
    return this.stats?.phase ?? 'Idle';
  }

  get statusIndicatorClass(): string {
    const phase = this.phaseText.toLowerCase();
    if (phase.includes('error')) return 'dot dot-error';
    if (phase.includes('ingesting') || phase.includes('matching') || phase.includes('fuzzy')) return 'dot dot-running';
    return 'dot dot-idle';
  }

  get isPipelinePhaseActive(): boolean {
    const phase = this.phaseText.toLowerCase();
    return phase.includes('ingesting') || phase.includes('deterministic') ||
      phase.includes('fuzzy') || phase.includes('matching');
  }

  get isBusy(): boolean {
    return this.isPipelineStarting || this.isAiRunning || this.isPipelinePhaseActive;
  }

  get pipelineButtonLabel(): string {
    return this.isPipelineStarting || this.isPipelinePhaseActive ? 'Pipeline Running...' : 'Run Pipeline';
  }

  get aiButtonLabel(): string {
    if (this.isAiRunning) return 'Analyzing...';
    return 'Analyze Shadow IT + Review (AI)';
  }

  get canRunAi(): boolean {
    const total = (this.stats.found || 0) + (this.stats.review || 0) + (this.stats.notfound || 0);
    return !this.isBusy && total > 0;
  }

  // ─── Tab switching ─────────────────────────────────────────────────────────

  switchTab(tab: 'dashboard' | 'table'): void {
    this.currentTab = tab;
    this.error = '';
    this.audit('tab_switched', { tab });
    // No data loading here — ResultsTableComponent manages its own state.
    // Charts re-init is handled via [visible] input binding.
  }

  // ─── Pipeline actions ──────────────────────────────────────────────────────

  startIngestion(): void {
    if (this.isBusy) return;
    this.error = '';
    this.isPipelineStarting = true;
    this.audit('pipeline_started');
    this.state.resetDataReady();

    this.api.startProcessing().subscribe({
      next: res => {
        this.isPipelineStarting = false;
        if (res?.already_running) {
          this.error = `Pipeline already running (${res.phase || this.phaseText}).`;
        }
      },
      error: (err: HttpErrorResponse | unknown) => {
        this.isPipelineStarting = false;
        this.error = this.extractError(err, 'Failed to start pipeline.');
      },
    });
  }

  triggerAI(): void {
    if (!this.canRunAi) return;
    this.error = '';
    this.isAiRunning = true;
    this.audit('ai_analysis_started');

    this.api.runAiAnalysis('ALL').subscribe({
      next: () => {
        this.isAiRunning = false;
        this.state.resetDataReady();
      },
      error: (err: HttpErrorResponse | unknown) => {
        this.isAiRunning = false;
        this.error = this.extractError(err, 'Failed to start AI analysis.');
      },
    });
  }

  downloadResults(): void {
    this.audit('export_triggered');
    this.api.exportResults('ALL');
  }

  // ─── Private: data loading ─────────────────────────────────────────────────

  private loadInitialState(): void {
    this.isDashboardLoading = true;
    forkJoin({ stats: this.api.getStats(), kpi: this.api.getKpi(), chart: this.api.getChartData() })
      .pipe(
        retry({ count: 2, delay: (_e, i) => timer(Math.min(1000 * 2 ** i, 4000)) }),
        finalize(() => { this.isDashboardLoading = false; }),
        takeUntil(this.destroy$)
      )
      .subscribe({
        next: result => {
          this.stats = result.stats;
          this.kpi = result.kpi;
          this.chartData = result.chart;
          this.state.stats$.next(result.stats);
          this.state.kpi$.next(result.kpi);
          this.state.chartData$.next(result.chart);
          this.state.updateDataReady(result.stats, result.kpi);
          this.lastSyncLabel = new Date().toLocaleTimeString();
          this.cdr.detectChanges();
        },
        error: (err: HttpErrorResponse | unknown) => {
          this.error = this.extractError(err, 'Failed to load dashboard data.');
        },
      });
  }

  private startPolling(): void {
    timer(1500, this.POLL_INTERVAL_MS)
      .pipe(
        exhaustMap(() => {
          this.pollStats();
          return EMPTY;
        }),
        takeUntil(this.destroy$)
      )
      .subscribe();
  }

  private pollStats(): void {
    this.api.getStats()
      .pipe(
        retry({ count: 2, delay: (_e, i) => timer(Math.min(1000 * 2 ** i, 5000)) }),
        catchError(err => {
          this.pollFailureCount++;
          if (this.pollFailureCount >= 3) {
            this.isPollingHealthy = false;
            this.error = this.extractError(err, 'Polling failed repeatedly.');
          }
          return EMPTY;
        }),
        takeUntil(this.destroy$)
      )
      .subscribe(stats => {
        this.pollFailureCount = 0;
        this.isPollingHealthy = true;
        this.stats = stats;
        this.state.stats$.next(stats);
        this.lastSyncLabel = new Date().toLocaleTimeString();
        this.statsPollTick++;

        const phase = (stats.phase || '').toLowerCase();
        const isActive = phase.includes('deterministic') || phase.includes('fuzzy') || phase.includes('matching');

        if (isActive) {
          // Refresh KPI/chart every ~15s (3 ticks × 5s) during active pipeline
          if (this.statsPollTick % 3 === 0) {
            forkJoin({ kpi: this.api.getKpi(), chart: this.api.getChartData() })
              .pipe(takeUntil(this.destroy$))
              .subscribe(({ kpi, chart }) => {
                this.kpi = kpi;
                this.chartData = chart;
                this.state.kpi$.next(kpi);
                this.state.chartData$.next(chart);
              });
          }
          // Tell results table to silently refresh if it's visible
          if (this.currentTab === 'table') {
            this.resultsTable?.silentRefreshIfStale();
          }
        }

        // Notify results table when pipeline goes from active → idle
        const wasActive = this.isPipelinePhaseActive;
        if (wasActive && phase === 'idle') {
          this.state.notifyPipelineComplete();
        }

        this.cdr.markForCheck();
      });
  }

  private extractError(error: HttpErrorResponse | Error | unknown, fallback: string): string {
    if (error instanceof HttpErrorResponse) {
      if (error.status === 0) return 'Cannot reach server. Check your network connection.';
      if (error.status === 409) return 'A conflicting pipeline job is already in progress.';
      if (error.status >= 500) return 'Server-side error. Please contact the backend team.';
      return error.error?.error || error.error?.message || error.message || fallback;
    }
    if (error instanceof Error) return error.message || fallback;
    return fallback;
  }

  private audit(event: string, context: Record<string, unknown> = {}): void {
    this.api.auditUiEvent({ event, context })
      .pipe(catchError(() => EMPTY), takeUntil(this.destroy$))
      .subscribe();
  }
}
