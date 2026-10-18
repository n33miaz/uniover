import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';

interface ModuleCard {
  readonly id: string;
  readonly path: string;
  readonly title: string;
}

@Component({
  selector: 'app-home-page',
  imports: [RouterLink],
  templateUrl: './home-page.html',
  styleUrl: './home-page.css',
})
export class HomePage {
  protected readonly modules: readonly ModuleCard[] = [
    { id: 'tv', path: '/tv', title: $localize`:@@home.card.tv:TV` },
    { id: 'training', path: '/treino', title: $localize`:@@home.card.training:Treino` },
  ];
}
