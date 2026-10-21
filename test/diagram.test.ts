import { describe, expect, it } from 'vitest';
import { layout, renderDiagram } from '../src/ui/diagram';
import type { Architecture } from '../src/store/types';

const portal: Architecture = {
  summary: '',
  parts: [
    { id: 'designer', name: 'Designer', summary: 'Edits content.', paths: ['src'], runs: 'browser' },
    { id: 'publisher', name: 'Publisher', summary: 'Builds the static site.', paths: ['src/publishing'], runs: 'Node at build time' },
    { id: 'site', name: 'Published site', summary: 'What visitors see.', paths: ['src/components'], runs: 'Azure Static Web Apps' },
    { id: 'apim', name: 'API Management', summary: 'Management API.', paths: [], external: true },
    { id: 'aad', name: 'Azure AD B2C', summary: 'Signs users in.', paths: [], external: true },
  ],
  links: [
    { from: 'designer', to: 'publisher', how: 'starts publishing', evidence: { file: 'a.ts', line: 1, verified: true } },
    { from: 'publisher', to: 'site', how: 'writes the files it serves' },
    { from: 'site', to: 'apim', how: 'calls its REST API' },
    { from: 'designer', to: 'apim', how: 'saves content through it' },
    { from: 'site', to: 'aad', how: 'signs users in' },
    { from: 'apim', to: 'designer', how: 'a cycle the layout must survive' },
  ],
};

describe('architecture diagram', () => {
  it('places parts in rows along the links, outside services at the bottom', () => {
    const { boxes } = layout(portal);
    const row = (id: string) => boxes.get(id)!.row;
    expect(row('designer')).toBe(0);
    expect(row('publisher')).toBe(1);
    expect(row('site')).toBe(2);
    expect(row('apim')).toBe(3);
    expect(row('aad')).toBe(3);
  });

  it('routes each link from the bottom of one box to the top of another, or back up for a cycle', () => {
    const { boxes, routes } = layout(portal);
    const down = routes.get(0)!; // designer -> publisher
    expect(down[0].y).toBe(boxes.get('designer')!.y + 58);
    expect(down.at(-1)!.y).toBe(boxes.get('publisher')!.y);
    const skip = routes.get(3)!; // designer -> apim passes the two rows between
    expect(skip).toHaveLength(6);
    const back = routes.get(5)!; // apim -> designer closes the cycle
    expect(back[0].y).toBe(boxes.get('apim')!.y);
    expect(back.at(-1)!.y).toBe(boxes.get('designer')!.y + 58);
    // Two links leave the designer from different spots.
    const leaving = [0, 3, 5].map((i) => (i === 5 ? routes.get(i)!.at(-1)! : routes.get(i)![0]).x);
    expect(new Set(leaving).size).toBe(3);
  });

  it('keeps a long chain narrow', () => {
    const chain: Architecture = {
      summary: '',
      parts: ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id, name: id, summary: '', paths: [] })),
      links: ['a', 'b', 'c', 'd', 'e'].map((id, i) => ({ from: id, to: 'bcdef'[i], how: '' })),
    };
    expect(layout(chain).width).toBeLessThan(250);
  });

  it('draws a box per part and an arrow per link, dashing what the AI inferred', () => {
    const svg = renderDiagram(portal);
    expect(svg.match(/<g class="part/g)).toHaveLength(5);
    expect(svg.match(/<path class="edge/g)).toHaveLength(6);
    expect(svg.match(/class="edge inferred"/g)).toHaveLength(5);
    expect(svg).toContain('class="part external"');
    expect(svg).toContain('data-action="map" data-type="part" data-id="site"');
    expect(svg).toContain('Azure Static Web Apps');
  });

  it('escapes what the AI wrote', () => {
    const svg = renderDiagram({ summary: '', parts: [{ id: 'x', name: '<script>', summary: '"', paths: [] }], links: [] });
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
  });
});
