import { AfterViewInit, ChangeDetectorRef, Component, ElementRef, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';

import {
  EMPTY,
  Subject,
  Subscription,
  catchError,
  debounceTime,
  distinctUntilChanged,
  finalize,
  forkJoin,
  retry,
  switchMap,
  exhaustMap,
  take,
  takeUntil,
  timer,
  filter
} from 'rxjs';
import { Chart, ChartConfiguration, registerables } from 'chart.js';
import {
  BulkRecord,
  ApiService,
  ChartDataResponse,
  KpiResponse,
  ResultItem,
  StatsResponse,
} from '../../core/services/api.service';
import { MonitorStateService } from 'src/app/core/state/monitor-state.service';

Chart.register(...registerables);

@Component({
  selector: 'app-dashboard',
  standalone: false,
  templateUrl: './dashboard.component.html',
  styleUrls: ['./dashboard.component.scss'],
})
export class DashboardComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('statusCanvas') statusCanvas?: ElementRef<HTMLCanvasElement>;
  @ViewChild('methodCanvas') methodCanvas?: ElementRef<HTMLCanvasElement>;

  readonly pageSize = 50;

  statusFilter = 'ALL';
  methodFilter = 'ALL';
  searchTerm = '';
  aiFilterActive = false;
  currentTab: 'dashboard' | 'table' = 'dashboard';

  currentSort: 'status' | 'raw_name' | 'publisher' | 'method' = 'raw_name';
  currentSortDir: 'ASC' | 'DESC' = 'ASC';

  currentPage = 1;
  totalPages = 1;
  totalRows = 0;
  rows: ResultItem[] = [];
  selectedRecords: BulkRecord[] = [];

  stats: StatsResponse = { phase: 'Idle', found: 0, review: 0, notfound: 0 };
  kpi: KpiResponse = {} as KpiResponse;
  chartData: ChartDataResponse = {} as ChartDataResponse;

  isDashboardLoading = true;
  isTableLoading = false;
  isPipelineStarting = false;
  isCleanupRunning = false;
  isAiRunning = false;
  isPollingHealthy = true;
  lastSyncLabel = 'Never';
  error = '';

  private destroy$ = new Subject<void>();
  private searchInput$ = new Subject<string>();
  private pollFailureCount = 0;
  private tableRequestSub?: Subscription;
  private lastSilentTableRefresh = 0;
  private statsPollTick = 0;
  private statusChart?: Chart;
  private methodChart?: Chart;


constructor(
  private api: ApiService,
  public state: MonitorStateService,
  private cdr: ChangeDetectorRef
) {}

ngOnInit(): void {
  this.setupSearchDebounce();

  this.state.stats$
    .pipe(takeUntil(this.destroy$))
    .subscribe(s => {
      if (s) {
        this.stats = s;
        this.state.updateDataReady(s, this.kpi);
        this.cdr.markForCheck();
      }
    });

  this.state.kpi$
    .pipe(takeUntil(this.destroy$))
    .subscribe(k => {
      if (k) {
        this.kpi = k;
        this.state.updateDataReady(this.stats, k);
        this.cdr.markForCheck();
      }
    });

  this.state.chartData$ // Moved this subscription up for better logical grouping
    .pipe(takeUntil(this.destroy$))
    .subscribe(c => {
      if (c) {
        this.chartData = c;
        this.applyChartData();
        this.cdr.markForCheck();
      }
    });

  // Subscribe to results to populate the table rows
  this.state.results$
    .pipe(takeUntil(this.destroy$))
    .subscribe(r => {
      this.rows = r || [];
      this.cdr.markForCheck();
    });

  // Start loading data immediately
  this.loadInitialState();

  this.state.resultsFilter$
    .pipe(takeUntil(this.destroy$))
    .subscribe(f => {
      this.statusFilter = f.status;
      this.currentPage = f.page;
      this.refreshTable(true);
    });

  this.startPolling();
}

  get isPipelinePhaseActive(): boolean {
    const phase = (this.phaseText || '').toLowerCase();
    return (
      phase.includes('ingesting') ||
      phase.includes('deterministic') ||
      phase.includes('fuzzy') ||
      phase.includes('matching')
    );
  }

  get isBusy(): boolean {
    return this.isPipelineStarting || this.isCleanupRunning || this.isAiRunning || this.isPipelinePhaseActive;
  }

ngAfterViewInit(): void {
  this.state.dataReady$
    .pipe(filter(Boolean), takeUntil(this.destroy$))
    .subscribe(() => {
      this.initializeCharts();
    });
}

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
    this.tableRequestSub?.unsubscribe();
    this.statusChart?.destroy();
    this.methodChart?.destroy();
  }

  get phaseText(): string {
    return this.stats?.phase ?? 'Idle';
  }

  get statusIndicatorClass(): string {
    const phase = this.phaseText.toLowerCase();
    if (phase.includes('error')) {
      return 'dot dot-error';
    }
    if (phase.includes('ingesting') || phase.includes('matching') || phase.includes('fuzzy')) {
      return 'dot dot-running';
    }
    return 'dot dot-idle';
  }

  get aiButtonLabel(): string {
    if (this.isAiRunning) {
      return 'Analyzing...';
    }
    if (this.statusFilter === 'Compliant') {
      return 'AI not applicable';
    }
    if (this.statusFilter === 'ALL') {
      return 'Analyze Shadow IT + Review (AI)';
    }
    return `Analyze ${this.statusFilter} (AI)`;
  }

  get canRunAi(): boolean {
    const total = (this.stats.found || 0) + (this.stats.review || 0) + (this.stats.notfound || 0);
    return !this.isBusy && this.statusFilter !== 'Compliant' && total > 0;
  }

  get pipelineButtonLabel(): string {
    if (this.isPipelineStarting || this.isPipelinePhaseActive) {
      return 'Pipeline Running...';
    }
    return 'Run Pipeline';
  }

  get cleanupButtonLabel(): string {
    return this.isCleanupRunning ? 'Cleaning...' : 'AI Cleanup';
  }

  get filteredMethodOptions(): string[] {
    const methodsByStatus: Record<string, string[]> = {
      Compliant: ['ALL', 'AI', 'AI-CLEANUP', 'EXACT', 'MANUAL'],
      REVIEW: ['ALL', 'AI', 'FUZZY', 'MANUAL'],
      'Shadow IT': ['ALL', 'AI', 'AI-CLEANUP', 'MANUAL'],
      ALL: ['ALL', 'AI', 'AI-CLEANUP', 'EXACT', 'FUZZY', 'MANUAL'],
    };

    return methodsByStatus[this.statusFilter] ?? methodsByStatus.ALL;
  }

  switchTab(tab: 'dashboard' | 'table') {
    this.currentTab = tab;
    this.error = '';
    this.audit('tab_switched', { tab });

    if (tab === 'dashboard') {
      // Ensure charts are drawn when switching back to the dashboard tab
      setTimeout(() => this.initializeCharts(), 50);
    }

    if (tab === 'table') {
      this.state.resultsFilter$.next({
        status: this.statusFilter,
        page: this.currentPage,
        limit: this.pageSize
      });
    }
  }

  toggleSort(column: 'status' | 'raw_name' | 'publisher' | 'method'): void {
    if (this.currentSort === column) {
      this.currentSortDir = this.currentSortDir === 'ASC' ? 'DESC' : 'ASC';
    } else {
      this.currentSort = column;
      this.currentSortDir = 'ASC';
    }
    this.currentPage = 1;
    this.refreshTable(false);
  }

  sortIndicator(column: 'status' | 'raw_name' | 'publisher' | 'method'): string {
    if (this.currentSort !== column) {
      return '';
    }
    return this.currentSortDir === 'ASC' ? '↑' : '↓';
  }

  onStatusFilterChange(): void {
    if (!this.filteredMethodOptions.includes(this.methodFilter)) {
      this.methodFilter = 'ALL';
    }
    this.currentPage = 1;
    this.audit('filter_status_changed', { status: this.statusFilter });
    this.refreshTable(false);
  }

  onMethodFilterChange(): void {
    this.currentPage = 1;
    this.audit('filter_method_changed', { method: this.methodFilter });
    this.refreshTable(false);
  }

  onSearchChange(): void {
    this.searchInput$.next(this.searchTerm);
  }

  toggleAIFilter(): void {
    this.aiFilterActive = !this.aiFilterActive;
    this.currentPage = 1;
    this.audit('ai_only_toggled', { active: this.aiFilterActive });
    this.refreshTable(false);
  }

  changePage(delta: number): void {
    const next = this.currentPage + delta;
    if (next < 1 || next > this.totalPages) {
      return;
    }
    this.currentPage = next;
    this.refreshTable(false);
  }

  get hasSelection(): boolean {
    return this.selectedRecords.length > 0;
  }

  get allRowsSelected(): boolean {
    return this.rows.length > 0 && this.rows.every((row) => this.isRowSelected(row));
  }

  isRowSelected(row: ResultItem): boolean {
    const key = this.rowKey(row.package_name, row.publisher);
    return this.selectedRecords.some((r) => this.rowKey(r.raw_name, r.raw_pub) === key);
  }

  toggleSelectAll(checked: boolean): void {
    if (!checked) {
      this.rows.forEach((row) => this.removeSelection(row.package_name, row.publisher));
      return;
    }

    this.rows.forEach((row) => {
      const exists = this.isRowSelected(row);
      if (!exists) {
        this.selectedRecords.push({
          raw_name: row.package_name || '',
          raw_pub: row.publisher || '',
        });
      }
    });
  }

  toggleRowSelection(row: ResultItem, checked: boolean): void {
    if (checked) {
      if (!this.isRowSelected(row)) {
        this.selectedRecords.push({
          raw_name: row.package_name || '',
          raw_pub: row.publisher || '',
        });
      }
      return;
    }

    this.removeSelection(row.package_name, row.publisher);
  }

  clearSelection(): void {
    this.selectedRecords = [];
  }

  bulkUpdateStatus(status: 'Compliant' | 'REVIEW' | 'Shadow IT'): void {
    if (!this.selectedRecords.length) {
      return;
    }

    const confirmed = window.confirm(`Update ${this.selectedRecords.length} record(s) to ${status}?`);
    if (!confirmed) {
      return;
    }

    this.api.bulkUpdateStatus(this.selectedRecords, status).subscribe({
      next: (res) => {
        this.audit('bulk_status_update', { status, count: res.count });
        this.clearSelection();
        this.refreshTable(false);
        this.loadStatsOnly();
      },
      error: (err) => {
        this.error = this.extractError(err, 'Bulk update failed.');
      },
    });
  }

  startIngestion(): void {
    if (this.isPipelinePhaseActive) {
      this.error = `Pipeline already running (${this.phaseText}). Please wait for completion.`;
      return;
    }

    if (this.isBusy) {
      return;
    }

    this.error = '';
    this.isPipelineStarting = true;
    this.audit('pipeline_started');

    this.api.startProcessing().subscribe({
      next: (res) => {
        this.isPipelineStarting = false;
        if (res?.already_running) {
          this.error = `Pipeline already running (${res.phase || this.phaseText}).`;
        }
        this.state.resetDataReady();
      },
      error: (err) => {
        this.isPipelineStarting = false;
        this.error = this.extractError(err, 'Failed to start pipeline.');
      },
    });
  }

  runShadowITCleanup(): void {
    // Cleanup endpoint removed - user runs bucketing script before pipeline
    this.error = 'AI cleanup has been removed. Please run the bucketing script separately.';
  }

  triggerAI(): void {
    if (!this.canRunAi) {
      return;
    }

    this.error = '';
    this.isAiRunning = true;
    this.audit('ai_analysis_started', { status_filter: this.statusFilter });

    this.api.runAiAnalysis(this.statusFilter).subscribe({
      next: () => {
        this.isAiRunning = false;
        this.state.resetDataReady();
      },
      error: (err) => {
        this.isAiRunning = false;
        this.error = this.extractError(err, 'Failed to start AI analysis.');
      },
    });
  }

  downloadResults(): void {
    this.audit('export_triggered', { status_filter: this.statusFilter });
    this.api.exportResults(this.statusFilter);
  }

  statusBadgeClass(status: string): string {
    const normalized = (status || '').toUpperCase();
    if (normalized === 'COMPLIANT') {
      return 'badge badge-green';
    }
    if (normalized === 'REVIEW' || normalized === 'AMBER') {
      return 'badge badge-yellow';
    }
    return 'badge badge-red';
  }

  methodClass(method: string): string {
    const normalized = (method || '').toUpperCase();
    if (normalized.includes('AI')) {
      return 'text-purple-700 font-semibold';
    }
    if (normalized.includes('EXACT')) {
      return 'text-green-700 font-semibold';
    }
    if (normalized.includes('FUZZY')) {
      return 'text-orange-700 font-semibold';
    }
    return 'text-slate-600';
  }

  displayCmdb(row: ResultItem): string {
    const method = (row.match_method || '').toUpperCase();
    const status = (row.status || '').toUpperCase();

    if (method.includes('AI-CLEANUP') && row.reasoning) {
      return row.reasoning.length > 55 ? `${row.reasoning.slice(0, 52)}...` : row.reasoning;
    }

    if (status !== 'SHADOW IT' && row.cmdb_match) {
      return row.cmdb_match;
    }

    return '-';
  }

  get displayStart(): number {
    if (!this.rows.length) {
      return 0;
    }
    return (this.currentPage - 1) * this.pageSize + 1;
  }

  get displayEnd(): number {
    if (!this.rows.length) {
      return 0;
    }
    return this.displayStart + this.rows.length - 1;
  }

  get kpiMatchRate(): string {
    return this.kpi ? `${this.toPercent(this.kpi.match_rate)}%` : '—';
  }

  get kpiReviewRate(): string {
    return this.kpi ? `${this.toPercent(this.kpi.review_rate)}%` : '—';
  }

  get kpiUnmatchedRate(): string {
    return this.kpi ? `${this.toPercent(this.kpi.unmatched_rate)}%` : '—';
  }

  get kpiAiEffectiveness(): string {
    return this.kpi ? `${this.toPercent(this.kpi.ai_effectiveness)}%` : '—';
  }

  get kpiTotalPackages(): number {
    return this.toNumber(this.kpi.total_packages);
  }

  get kpiTotalCmdb(): number {
    return this.toNumber(this.kpi.total_cmdb);
  }

  get kpiSamNotCmdb(): number {
    return this.toNumber(this.kpi.shadow_it ?? this.kpi.in_sam_not_cmdb);
  }

  get kpiCmdbNotSam(): number {
    if (this.kpi.in_cmdb_not_sam != null) {
      return this.toNumber(this.kpi.in_cmdb_not_sam);
    }
    return Math.max(0, this.kpiTotalCmdb - this.toNumber(this.kpi.unique_cmdb_matched));
  }

  get kpiAiProcessed(): number {
    return this.toNumber(this.kpi.ai_processed);
  }

  get kpiAiSuccessRate(): string {
    const aiProcessed = this.toNumber(this.kpi.ai_processed);
    const aiMatches = this.toNumber(this.kpi.ai_matches);
    const rate = aiProcessed > 0 ? (aiMatches / aiProcessed) * 100 : 0;
    return `${this.toPercent(rate)}%`;
  }

  get kpiPendingReview(): number {
    return this.toNumber(this.kpi.review_matches);
  }

  get kpiAutomationRate(): string {
    const compliant = this.toNumber(this.kpi.compliant_matches);
    const exact = this.toNumber(this.kpi.exact_matches);
    const ai = this.toNumber(this.kpi.ai_matches);
    const rate = compliant > 0 ? ((exact + ai) / compliant) * 100 : 0;
    return `${this.toPercent(rate)}%`;
  }

  get kpiCmdbCoverage(): string {
    return `${this.toPercent(this.kpi.cmdb_coverage)}%`;
  }

  private loadInitialState(): void {
    this.isDashboardLoading = true;
    forkJoin({
      stats: this.api.getStats(),
      kpi: this.api.getKpi(),
      chart: this.api.getChartData(),
    })
      .pipe(
        retry({
          count: 2,
          delay: (_error, retryIndex) => timer(Math.min(1000 * 2 ** retryIndex, 4000)),
        }),
        finalize(() => {
          this.isDashboardLoading = false;
        }),
        takeUntil(this.destroy$)
      )
      .subscribe({

        next: (result) => {
          // Assign local variables first to ensure they are available for updateDataReady
          this.stats = result.stats;
          this.kpi = result.kpi;
          this.chartData = result.chart;

          this.state.stats$.next(result.stats);
          this.state.kpi$.next(result.kpi);
          this.state.chartData$.next(result.chart);
          this.state.updateDataReady(result.stats, result.kpi); // Ensure dataReady is set after initial load

          this.lastSyncLabel = new Date().toLocaleTimeString();
          this.cdr.detectChanges();
        },
        error: (err) => {
          this.error = this.extractError(err, 'Failed to load dashboard data.');
        },
      });
  }

  private loadStatsOnly(): void {
    this.api
      .getStats()
      .pipe(
        retry({
          count: 2,
          delay: (_error, retryIndex) => timer(Math.min(1000 * 2 ** retryIndex, 5000)),
        }),
        catchError((err) => {
          this.pollFailureCount += 1;
          if (this.pollFailureCount >= 3) {
            this.isPollingHealthy = false;
            this.error = this.extractError(err, 'Polling failed repeatedly. Retrying in background.');
          }
          return EMPTY;
        }),
        takeUntil(this.destroy$)
      )
      .subscribe({
        next: (stats) => {
          this.pollFailureCount = 0;
          this.isPollingHealthy = true;
          this.state.stats$.next(stats);
          this.lastSyncLabel = new Date().toLocaleTimeString();
          this.statsPollTick += 1;
          
          const phase = (stats.phase || '').toLowerCase();
          if (phase.includes('deterministic') || phase.includes('fuzzy') || phase.includes('matching')) {
            // Reduce heavy KPI/chart fetches while pipeline is running.
            // Refresh them every ~15 seconds (poll every 5 seconds, each 3 ticks).
            if (this.statsPollTick % 3 === 0) {
              forkJoin({
                kpi: this.api.getKpi(),
                chart: this.api.getChartData(),
              })
                .pipe(takeUntil(this.destroy$))
                .subscribe(({ kpi, chart }) => {
                  this.state.stats$.next(stats);
                  this.state.kpi$.next(kpi);
                  this.state.chartData$.next(chart);
                });
            }

            const now = Date.now();
            if (this.currentTab === 'table' && now - this.lastSilentTableRefresh > 12000) {
              this.lastSilentTableRefresh = now;
              this.refreshTable(false, true);
            }
          }
        },
      });
  }

  refreshTable(resetPage: boolean, silent = false): void {
    if (resetPage) {
      this.currentPage = 1;
    }

    // Use normal page size; pagination handled on backend
    const requestLimit = this.pageSize;
    const requestPage = this.currentPage;

    if (!silent) {
      this.isTableLoading = true;
    }

    this.tableRequestSub?.unsubscribe();

    this.tableRequestSub = this.api
      .getResults(
        requestPage,
        requestLimit,
        this.statusFilter,
        this.methodFilter,
        this.searchTerm,
        this.currentSort,
        this.currentSortDir,
        this.aiFilterActive  // Pass AI filter flag to backend
      )
      .pipe(
        retry({
          count: 1,
          delay: (_error, retryIndex) => timer(600 * (retryIndex + 1)),
        }),
        finalize(() => {
          if (!silent) {
            this.isTableLoading = false;
          }
        }),
        takeUntil(this.destroy$)
      )
      .subscribe({
        next: (response) => {
          if (silent && this.currentTab !== 'table') {
            return;
          }

          const rows = response.data || [];
          this.totalRows = response.total || rows.length;
          this.totalPages = Math.max(1, response.total_pages || 1);
          this.state.results$.next(rows);

          if (this.currentPage > this.totalPages) {
            this.currentPage = 1;
          }

          if (!silent) {
            this.error = '';
          }
        },
        error: (err) => {
          this.rows = [];
          this.totalRows = 0;
          this.totalPages = 1;
          this.error = this.extractError(err, 'Failed to load table data.');
        },
      });
  }

  private initializeCharts(): void {
    if (!this.statusCanvas || !this.methodCanvas) {
      return;
    }

    // Capture native elements locally to satisfy TS compiler inside setTimeout closure
    const statusEl = this.statusCanvas.nativeElement;
    const methodEl = this.methodCanvas.nativeElement;

    // Wrap in timeout to ensure DOM has finalized dimensions
    setTimeout(() => {
      this.statusChart?.destroy();
      this.methodChart?.destroy();

      const statusConfig: ChartConfiguration<'doughnut'> = {
        type: 'doughnut',
        data: {
          labels: ['Compliant', 'Shadow IT', 'Review'],
          datasets: [{
            data: [0, 0, 0],
            backgroundColor: ['#86efac', '#fca5a5', '#fde047'],
            borderColor: '#ffffff',
            borderWidth: 2,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { position: 'bottom' } },
        },
      };

      const methodConfig: ChartConfiguration<'doughnut'> = {
        type: 'doughnut',
        data: {
          labels: ['Exact', 'AI', 'Manual'],
          datasets: [{
            data: [0, 0, 0],
            backgroundColor: ['#10b981', '#a855f7', '#3b82f6'],
            borderColor: '#ffffff',
            borderWidth: 2,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { position: 'bottom' } },
        },
      };

      this.statusChart = new Chart(statusEl, statusConfig);
      this.methodChart = new Chart(methodEl, methodConfig);

      if (this.chartData && Object.keys(this.chartData).length > 0) {
        this.applyChartData();
      }
    }, 0);
  }

  private applyChartData(): void {
    if (!this.statusChart || !this.methodChart) {
      // If data arrives before view is ready, trigger initialization
      this.initializeCharts();
      return;
    }

    if (this.statusChart) {
      this.statusChart.data.datasets[0].data = [
        this.toNumber(this.chartData.compliant),
        this.toNumber(this.chartData.shadowit),
        this.toNumber(this.chartData.review),
      ];
      this.statusChart.update();
    }

    if (this.methodChart) {
      const labels = this.chartData.method_labels || ['Exact', 'AI', 'Manual'];
      this.methodChart.data.labels = labels;

      // Dynamically map data to match the labels returned by the backend
      const data = labels.map(label => {
        const l = label.toUpperCase();
        if (l === 'EXACT') return this.toNumber(this.chartData.exact_count);
        if (l === 'AI' || l === 'AI-CLEANUP') return this.toNumber(this.chartData.ai_count);
        return 0; // Fallback for 'Manual' or other labels
      });

      this.methodChart.data.datasets[0].data = data;
      this.methodChart.update();
    }
  }

  private toNumber(value: unknown): number {
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private toPercent(value: unknown): string {
    const num = this.toNumber(value);
    return Number.isInteger(num) ? String(num) : num.toFixed(2);
  }

  private extractError(error: HttpErrorResponse | any, fallback: string): string {
    if (error instanceof HttpErrorResponse) {
      // Handle specific HTTP status codes for production visibility
      if (error.status === 0) return 'Cannot reach server. Please check your network connection.';
      if (error.status === 409) return 'A conflicting pipeline job is already in progress.';
      if (error.status >= 500) return 'Server-side error occurred. Please contact the backend team.';
      
      return error.error?.error || error.error?.message || error.message || fallback;
    }
    return error?.message || fallback;
  }

  private setupSearchDebounce(): void {
    this.searchInput$
      .pipe(debounceTime(300), distinctUntilChanged(), takeUntil(this.destroy$))
      .subscribe(() => {
        this.currentPage = 1;
        this.refreshTable(false);
      });
  }

  private startPolling(): void {
    // Using exhaustMap ensures we don't start a new request 
    // if the previous poll is still pending (prevents request piling)
    timer(1500, 5000)
      .pipe(
        exhaustMap(() => {
          this.loadStatsOnly();
          return EMPTY; // loadStatsOnly manages its own subscriptions
        }),
        takeUntil(this.destroy$)
      )
      .subscribe();
  }

  private rowKey(rawName: string, rawPub: string): string {
    return `${(rawName || '').trim().toLowerCase()}::${(rawPub || '').trim().toLowerCase()}`;
  }

  private removeSelection(rawName: string, rawPub: string): void {
    const key = this.rowKey(rawName, rawPub);
    this.selectedRecords = this.selectedRecords.filter((r) => this.rowKey(r.raw_name, r.raw_pub) !== key);
  }

  private audit(event: string, context: Record<string, unknown> = {}): void {
    this.api
      .auditUiEvent({ event, context })
      .pipe(
        catchError(() => EMPTY),
        takeUntil(this.destroy$)
      )
      .subscribe();
  }
}
