import { Component, OnInit } from '@angular/core';
import { ApiService, ResultItem, ResultsResponse } from '../../core/services/api.service';

const STATUS_TABS = ['ALL', 'FOUND', 'REVIEW', 'NOT_FOUND'] as const;

@Component({
  selector: 'app-results',
  template: `
    <div class="results-page">
      <h1>Results</h1>

      <!-- Filter Tabs -->
      <div class="tabs">
        <button *ngFor="let t of tabs" class="tab"
                [class.active]="activeTab === t"
                (click)="switchTab(t)">
          {{ t }}
        </button>
        <button class="btn btn-export" (click)="export()">⬇ Export Excel</button>
      </div>

      <!-- Search -->
      <input class="search-input" placeholder="Filter by package name..." [(ngModel)]="searchTerm" />

      <!-- Table -->
      <div class="table-wrapper">
        <table>
          <thead>
            <tr>
              <th>Package Name</th>
              <th>Publisher</th>
              <th>Status</th>
              <th>Method</th>
              <th>CMDB Match</th>
              <th>ML Bucket</th>
              <th>Confidence</th>
            </tr>
          </thead>
          <tbody>
            <tr *ngFor="let row of filteredRows">
              <td>{{ row.package_name }}</td>
              <td>{{ row.publisher }}</td>
              <td><span class="status-badge" [ngClass]="row.status.toLowerCase()">{{ row.status }}</span></td>
              <td>{{ row.match_method }}</td>
              <td>{{ row.cmdb_match }}</td>
              <td>
                <span class="bucket-badge" *ngIf="row.ml_bucket"
                      [ngStyle]="{'background': bucketColor(row.ml_bucket)}">
                  {{ row.ml_bucket }}
                </span>
                <span *ngIf="!row.ml_bucket" class="muted">—</span>
              </td>
              <td>
                <div class="conf-bar" *ngIf="row.ml_confidence">
                  <div class="conf-fill" [style.width.%]="row.ml_confidence * 100"></div>
                  <span>{{ (row.ml_confidence * 100).toFixed(0) }}%</span>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Pagination -->
      <div class="pagination">
        <button (click)="prevPage()" [disabled]="page === 1">◀ Prev</button>
        <span>Page {{ page }} / {{ totalPages }}</span>
        <button (click)="nextPage()" [disabled]="page >= totalPages">Next ▶</button>
      </div>
    </div>
  `,
  styleUrls: ['./results.component.scss'],
})
export class ResultsComponent implements OnInit {
  tabs = STATUS_TABS;
  activeTab: string = 'ALL';
  rows: ResultItem[] = [];
  searchTerm = '';
  page = 1;
  limit = 50;
  totalPages = 1;

  constructor(private api: ApiService) {}

  ngOnInit(): void { this.load(); }

  load(): void {
    this.api.getResults(this.page, this.limit, this.activeTab).subscribe((res: ResultsResponse) => {
      this.rows = res.data;
      this.totalPages = res.total_pages;
    });
  }

  switchTab(tab: string): void {
    this.activeTab = tab;
    this.page = 1;
    this.load();
  }

  get filteredRows(): ResultItem[] {
    if (!this.searchTerm) return this.rows;
    const q = this.searchTerm.toLowerCase();
    return this.rows.filter(r => r.package_name?.toLowerCase().includes(q));
  }

  prevPage(): void { if (this.page > 1) { this.page--; this.load(); } }
  nextPage(): void { if (this.page < this.totalPages) { this.page++; this.load(); } }
  export(): void { this.api.exportResults(this.activeTab); }

  bucketColor(bucket: string): string {
    const map: Record<string, string> = {
      SANCTIONED: '#16a34a', SHADOW_IT: '#dc2626', DEV_TOOL: '#2563eb',
      MIDDLEWARE: '#9333ea', OS_SYSTEM: '#64748b', REVIEW: '#d97706', UNKNOWN: '#1f2937',
    };
    return map[bucket] ?? '#6b7280';
  }
}
