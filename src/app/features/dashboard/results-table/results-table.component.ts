import {
  ChangeDetectorRef, Component, OnDestroy, OnInit
} from '@angular/core';
import {
  EMPTY, Subject, Subscription,
  catchError, debounceTime, distinctUntilChanged,
  finalize, retry, takeUntil, timer
} from 'rxjs';
import { ApiService, BulkRecord, ResultItem } from '../../../core/services/api.service';
import { MonitorStateService } from '../../../core/state/monitor-state.service';

interface PendingAction {
  status: 'Compliant' | 'REVIEW' | 'Shadow IT';
  count: number;
}

@Component({
  selector: 'app-results-table',
  standalone: false,
  templateUrl: './results-table.component.html',
})
export class ResultsTableComponent implements OnInit, OnDestroy {
  readonly PAGE_SIZE = 50;
  /** Interval (ms) between silent background refreshes while pipeline is running */
  private readonly SILENT_REFRESH_INTERVAL = 12_000;

  statusFilter = 'ALL';
  methodFilter = 'ALL';
  searchTerm = '';
  aiFilterActive = false;
  currentSort: 'status' | 'raw_name' | 'publisher' | 'method' = 'raw_name';
  currentSortDir: 'ASC' | 'DESC' = 'ASC';

  currentPage = 1;
  totalPages = 1;
  totalRows = 0;
  rows: ResultItem[] = [];
  selectedRecords: BulkRecord[] = [];

  isLoading = false;
  error = '';

  /** Replaces window.confirm — shown as an inline confirmation banner */
  pendingAction: PendingAction | null = null;

  private destroy$ = new Subject<void>();
  private searchInput$ = new Subject<string>();
  private tableRequestSub?: Subscription;
  private lastSilentRefresh = 0;

  constructor(
    private api: ApiService,
    private state: MonitorStateService,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    this.setupSearchDebounce();
    this.loadTable(false);

    // Refresh whenever the pipeline completes
    this.state.pipelineComplete$
      .pipe(takeUntil(this.destroy$))
      .subscribe(complete => {
        if (complete) this.loadTable(true);
      });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
    this.tableRequestSub?.unsubscribe();
  }

  // ─── Sorting ───────────────────────────────────────────────────────────────

  toggleSort(column: 'status' | 'raw_name' | 'publisher' | 'method'): void {
    if (this.currentSort === column) {
      this.currentSortDir = this.currentSortDir === 'ASC' ? 'DESC' : 'ASC';
    } else {
      this.currentSort = column;
      this.currentSortDir = 'ASC';
    }
    this.currentPage = 1;
    this.loadTable(false);
  }

  sortIndicator(column: string): string {
    if (this.currentSort !== column) return '';
    return this.currentSortDir === 'ASC' ? '↑' : '↓';
  }

  // ─── Filters ───────────────────────────────────────────────────────────────

  get filteredMethodOptions(): string[] {
    const map: Record<string, string[]> = {
      Compliant: ['ALL', 'AI', 'AI-CLEANUP', 'EXACT', 'MANUAL'],
      REVIEW: ['ALL', 'AI', 'FUZZY', 'MANUAL'],
      'Shadow IT': ['ALL', 'AI', 'AI-CLEANUP', 'MANUAL'],
      ALL: ['ALL', 'AI', 'AI-CLEANUP', 'EXACT', 'FUZZY', 'MANUAL'],
    };
    return map[this.statusFilter] ?? map['ALL'];
  }

  onStatusFilterChange(): void {
    if (!this.filteredMethodOptions.includes(this.methodFilter)) {
      this.methodFilter = 'ALL';
    }
    this.currentPage = 1;
    this.loadTable(false);
  }

  onMethodFilterChange(): void {
    this.currentPage = 1;
    this.loadTable(false);
  }

  onSearchChange(): void {
    this.searchInput$.next(this.searchTerm);
  }

  toggleAIFilter(): void {
    this.aiFilterActive = !this.aiFilterActive;
    this.currentPage = 1;
    this.loadTable(false);
  }

  // ─── Pagination ────────────────────────────────────────────────────────────

  changePage(delta: number): void {
    const next = this.currentPage + delta;
    if (next < 1 || next > this.totalPages) return;
    this.currentPage = next;
    this.loadTable(false);
  }

  get displayStart(): number {
    return this.rows.length ? (this.currentPage - 1) * this.PAGE_SIZE + 1 : 0;
  }

  get displayEnd(): number {
    return this.rows.length ? this.displayStart + this.rows.length - 1 : 0;
  }

  // ─── Row selection ─────────────────────────────────────────────────────────

  get hasSelection(): boolean {
    return this.selectedRecords.length > 0;
  }

  get allRowsSelected(): boolean {
    return this.rows.length > 0 && this.rows.every(r => this.isRowSelected(r));
  }

  isRowSelected(row: ResultItem): boolean {
    const key = this.rowKey(row.package_name, row.publisher);
    return this.selectedRecords.some(r => this.rowKey(r.raw_name, r.raw_pub) === key);
  }

  toggleSelectAll(checked: boolean): void {
    if (!checked) {
      this.rows.forEach(r => this.removeSelection(r.package_name, r.publisher));
      return;
    }
    this.rows.forEach(r => {
      if (!this.isRowSelected(r)) {
        this.selectedRecords.push({ raw_name: r.package_name || '', raw_pub: r.publisher || '' });
      }
    });
  }

  toggleRowSelection(row: ResultItem, checked: boolean): void {
    if (checked) {
      if (!this.isRowSelected(row)) {
        this.selectedRecords.push({ raw_name: row.package_name || '', raw_pub: row.publisher || '' });
      }
    } else {
      this.removeSelection(row.package_name, row.publisher);
    }
  }

  clearSelection(): void {
    this.selectedRecords = [];
    this.pendingAction = null;
  }

  // ─── Bulk actions (inline confirm — no window.confirm) ─────────────────────

  /** Step 1: user clicks a bulk-action button → shows inline confirm banner */
  requestBulkAction(status: 'Compliant' | 'REVIEW' | 'Shadow IT'): void {
    if (!this.selectedRecords.length) return;
    this.pendingAction = { status, count: this.selectedRecords.length };
  }

  /** Step 2a: user confirms in the banner → executes the API call */
  confirmBulkAction(): void {
    if (!this.pendingAction) return;
    const { status } = this.pendingAction;
    this.pendingAction = null;

    this.api.bulkUpdateStatus(this.selectedRecords, status).pipe(
      takeUntil(this.destroy$)
    ).subscribe({
      next: () => {
        this.clearSelection();
        this.loadTable(false);
      },
      error: (err: Error | unknown) => {
        this.error = this.extractError(err, 'Bulk update failed.');
      },
    });
  }

  /** Step 2b: user cancels */
  cancelBulkAction(): void {
    this.pendingAction = null;
  }

  // ─── Badges ────────────────────────────────────────────────────────────────

  statusBadgeClass(status: string): string {
    const s = (status || '').toUpperCase();
    if (s === 'COMPLIANT') return 'badge badge-green';
    if (s === 'REVIEW' || s === 'AMBER') return 'badge badge-yellow';
    return 'badge badge-red';
  }

  methodClass(method: string): string {
    const m = (method || '').toUpperCase();
    if (m.includes('AI')) return 'text-purple-700 font-semibold';
    if (m.includes('EXACT')) return 'text-green-700 font-semibold';
    if (m.includes('FUZZY')) return 'text-orange-700 font-semibold';
    return 'text-slate-600';
  }

  displayCmdb(row: ResultItem): string {
    const method = (row.match_method || '').toUpperCase();
    const status = (row.status || '').toUpperCase();
    if (method.includes('AI-CLEANUP') && row.reasoning) {
      return row.reasoning.length > 55 ? `${row.reasoning.slice(0, 52)}...` : row.reasoning;
    }
    if (status !== 'SHADOW IT' && row.cmdb_match) return row.cmdb_match;
    return '-';
  }

  // ─── Data loading ──────────────────────────────────────────────────────────

  loadTable(resetPage: boolean, silent = false): void {
    if (resetPage) this.currentPage = 1;
    if (!silent) this.isLoading = true;

    this.tableRequestSub?.unsubscribe();
    this.tableRequestSub = this.api
      .getResults(
        this.currentPage, this.PAGE_SIZE,
        this.statusFilter, this.methodFilter,
        this.searchTerm, this.currentSort, this.currentSortDir,
        this.aiFilterActive
      )
      .pipe(
        retry({ count: 1, delay: (_e, i) => timer(600 * (i + 1)) }),
        finalize(() => { if (!silent) this.isLoading = false; }),
        takeUntil(this.destroy$)
      )
      .subscribe({
        next: res => {
          this.rows = res.data || [];
          this.totalRows = res.total || this.rows.length;
          this.totalPages = Math.max(1, res.total_pages || 1);
          if (this.currentPage > this.totalPages) this.currentPage = 1;
          if (!silent) this.error = '';
          this.cdr.markForCheck();
        },
        error: (err: Error | unknown) => {
          this.rows = [];
          this.totalRows = 0;
          this.totalPages = 1;
          this.error = this.extractError(err, 'Failed to load table data.');
        },
      });
  }

  /** Called by the parent during active-pipeline polling */
  silentRefreshIfStale(): void {
    const now = Date.now();
    if (now - this.lastSilentRefresh > this.SILENT_REFRESH_INTERVAL) {
      this.lastSilentRefresh = now;
      this.loadTable(false, true);
    }
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private setupSearchDebounce(): void {
    this.searchInput$
      .pipe(debounceTime(300), distinctUntilChanged(), takeUntil(this.destroy$))
      .subscribe(() => {
        this.currentPage = 1;
        this.loadTable(false);
      });
  }

  private rowKey(rawName: string, rawPub: string): string {
    return `${(rawName || '').trim().toLowerCase()}::${(rawPub || '').trim().toLowerCase()}`;
  }

  private removeSelection(rawName: string, rawPub: string): void {
    const key = this.rowKey(rawName, rawPub);
    this.selectedRecords = this.selectedRecords.filter(r => this.rowKey(r.raw_name, r.raw_pub) !== key);
  }

  private extractError(error: Error | unknown, fallback: string): string {
    if (error instanceof Error) return error.message || fallback;
    return fallback;
  }
}
