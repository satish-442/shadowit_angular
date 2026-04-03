import { Component } from '@angular/core';
import { ApiService } from '../../core/services/api.service';

@Component({
  selector: 'app-upload',
  template: `
    <div class="upload-page">
      <h1>Upload Files</h1>
      <p class="subtitle">Upload your Packages Excel and CMDB Excel to begin processing.</p>

      <!-- Stepper -->
      <div class="stepper">
        <div class="step" [class.active]="step >= 1" [class.done]="step > 1">1. Upload Files</div>
        <div class="step-line"></div>
        <div class="step" [class.active]="step >= 2" [class.done]="step > 2">2. Run Matching</div>
        <div class="step-line"></div>
        <div class="step" [class.active]="step >= 3" [class.done]="step > 3">3. AI + ML Bucketing</div>
      </div>

      <!-- Step 1: Upload -->
      <div class="card" *ngIf="step === 1">
        <div class="dropzone" (dragover)="$event.preventDefault()" (drop)="onDrop($event, 'pkg')">
          <p>📦 Packages Excel</p>
          <input type="file" accept=".xlsx" (change)="onFileSelect($event, 'pkg')" />
          <span *ngIf="pkgFile">{{ pkgFile.name }}</span>
        </div>
        <div class="dropzone" (dragover)="$event.preventDefault()" (drop)="onDrop($event, 'cmdb')">
          <p>🗄️ CMDB Excel</p>
          <input type="file" accept=".xlsx" (change)="onFileSelect($event, 'cmdb')" />
          <span *ngIf="cmdbFile">{{ cmdbFile.name }}</span>
        </div>
        <button class="btn btn-primary" [disabled]="!pkgFile || !cmdbFile || loading" (click)="uploadFiles()">
          {{ loading ? 'Uploading...' : '⬆ Upload Files' }}
        </button>
      </div>

      <!-- Step 2: Run Matching -->
      <div class="card" *ngIf="step === 2">
        <p>Files uploaded ✅  Click below to run deterministic + fuzzy matching.</p>
        <button class="btn btn-primary" [disabled]="loading" (click)="startProcessing()">
          {{ loading ? 'Processing...' : '▶ Start Matching' }}
        </button>
      </div>

      <!-- Step 3: AI + ML -->
      <div class="card" *ngIf="step === 3">
        <p>Matching complete ✅  Optionally enrich with AI and ML bucketing.</p>
        <button class="btn btn-secondary" [disabled]="loading" (click)="runAi()">🤖 Run AI Analysis</button>
        <button class="btn btn-purple"    [disabled]="loading" (click)="runBucketing()">🪣 Run ML Bucketing</button>
        <a class="btn btn-outline" routerLink="/results">📊 View Results →</a>
      </div>

      <!-- Error -->
      <div class="error-box" *ngIf="error">⚠️ {{ error }}</div>
    </div>
  `,
  styleUrls: ['./upload.component.scss'],
})
export class UploadComponent {
  step = 1;
  pkgFile: File | null = null;
  cmdbFile: File | null = null;
  loading = false;
  error = '';

  constructor(private api: ApiService) {}

  onFileSelect(event: Event, type: 'pkg' | 'cmdb'): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (type === 'pkg') this.pkgFile = file ?? null;
    else this.cmdbFile = file ?? null;
  }

  onDrop(event: DragEvent, type: 'pkg' | 'cmdb'): void {
    event.preventDefault();
    const file = event.dataTransfer?.files[0];
    if (type === 'pkg') this.pkgFile = file ?? null;
    else this.cmdbFile = file ?? null;
  }

  uploadFiles(): void {
    if (!this.pkgFile || !this.cmdbFile) return;
    this.loading = true;
    this.error = '';
    this.api.uploadFiles(this.pkgFile, this.cmdbFile).subscribe({
      next: () => { this.step = 2; this.loading = false; },
      error: e  => { this.error = e.message; this.loading = false; },
    });
  }

  startProcessing(): void {
    this.loading = true;
    this.api.startProcessing().subscribe({
      next: () => { this.step = 3; this.loading = false; },
      error: e  => { this.error = e.message; this.loading = false; },
    });
  }

  runAi(): void {
    this.loading = true;
    this.api.runAiAnalysis().subscribe({ next: () => (this.loading = false), error: () => (this.loading = false) });
  }

  runBucketing(): void {
    this.loading = true;
    this.api.runBucketing().subscribe({ next: () => (this.loading = false), error: () => (this.loading = false) });
  }
}
