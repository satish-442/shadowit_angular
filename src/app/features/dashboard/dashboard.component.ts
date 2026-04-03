import { AfterViewInit, Component, ElementRef, OnDestroy, OnInit, ViewChild } from '@angular/core';
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
  takeUntil,
  timer,
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
  kpi: KpiResponse = {};
  chartData: ChartDataResponse = {
    compliant: 0,
    shadowit: 0,
    review: 0,
    exact_count: 0,
    ai_count: 0,
    manual_count: 0,
    method_labels: ['Exact', 'AI', 'Manual'],
  };

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

  constructor(private api: ApiService) {}

  ngOnInit(): void {
    this.setupSearchDebounce();
    this.loadInitialState();
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
    this.initializeCharts();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
    this.tableRequestSub?.unsubscribe();
    this.statusChart?.destroy();
    this.methodChart?.destroy();
  }

  get phaseText(): string {
    return this.stats.phase || 'Idle';
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

  switchTab(tab: 'dashboard' | 'table'): void {
    this.currentTab = tab;
    this.error = '';
    this.audit('tab_switched', { tab });
    if (tab === 'table') {
      this.refreshTable(false);
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
        this.loadInitialState();
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
        this.loadInitialState();
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
    return `${this.toPercent(this.kpi.match_rate)}%`;
  }

  get kpiReviewRate(): string {
    return `${this.toPercent(this.kpi.review_rate)}%`;
  }

  get kpiUnmatchedRate(): string {
    return `${this.toPercent(this.kpi.unmatched_rate)}%`;
  }

  get kpiAiEffectiveness(): string {
    return `${this.toPercent(this.kpi.ai_effectiveness)}%`;
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
          this.stats = result.stats;
          this.kpi = result.kpi;
          this.chartData = result.chart;
          this.lastSyncLabel = new Date().toLocaleTimeString();
          this.applyChartData();
          this.refreshTable(false);
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
          this.stats = stats;
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
                  this.kpi = kpi;
                  this.chartData = chart;
                  this.applyChartData();
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
          this.rows = rows;

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

    this.statusChart = new Chart(this.statusCanvas.nativeElement, statusConfig);
    this.methodChart = new Chart(this.methodCanvas.nativeElement, methodConfig);
    this.applyChartData();
  }

  private applyChartData(): void {
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
      this.methodChart.data.datasets[0].data = [
        this.toNumber(this.chartData.exact_count),
        this.toNumber(this.chartData.ai_count),
        this.toNumber(this.chartData.manual_count),
      ];
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

  private extractError(error: any, fallback: string): string {
    return (
      error?.error?.error
      || error?.error?.message
      || error?.error?.code
      || error?.message
      || fallback
    );
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
    timer(1500, 5000)
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => {
        this.loadStatsOnly();
      });
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
