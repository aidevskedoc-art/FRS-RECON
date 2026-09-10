import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { PageHeaderComponent } from '../../shared/ui/page-header.component';

/**
 * "How to Use" — an in-app operating guide for the reconciliation workflow,
 * from uploading the source records through to downloading the Audit Working
 * Report. Static content: diagrams and step lists, no data calls.
 *
 * Deliberately self-contained (no external links) so it works for a client on
 * an air-gapped install. The written long-form version lives outside the app.
 */
@Component({
  selector: 'app-how-to-use',
  standalone: true,
  imports: [RouterLink, PageHeaderComponent],
  templateUrl: './how-to-use.component.html',
  styleUrl: './how-to-use.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HowToUseComponent {}
