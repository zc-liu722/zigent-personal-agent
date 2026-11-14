import { readColors } from './read-colors.js';

function tint(color, paper, amount = .42) {
  const channels = [1, 3, 5].map(index => {
    const base = parseInt(paper.slice(index, index + 2), 16);
    const accent = parseInt(color.slice(index, index + 2), 16);
    return Math.round(base * (1 - amount) + accent * amount).toString(16).padStart(2, '0');
  });
  return `#${channels.join('')}`;
}

export function mermaidTheme(darkMode) {
  const color = readColors();
  const paper = color('ui-bg'), ink = color('ui-text'), soft = color('palette-soft');
  const line = color('palette-mermaid-edge'), border = color('palette-mermaid-border');
  const node = color('palette-mermaid-node'), nodeBorder = color('palette-mermaid-node-border');
  const noteBorder = color('ui-support'), note = tint(noteBorder, paper, .14);
  const critical = color('palette-mermaid-critical'), criticalFill = color('palette-mermaid-critical-fill');
  const series = Array.from({ length: 12 }, (_, i) => color(`ui-series-${i + 1}`));
  const fills = series.map(color => tint(color, paper));
  const variables = {
    darkMode, background: paper, useGradient: false,
    primaryColor: node, secondaryColor: soft, tertiaryColor: paper,
    primaryTextColor: ink, secondaryTextColor: ink, tertiaryTextColor: ink,
    primaryBorderColor: nodeBorder, secondaryBorderColor: border, tertiaryBorderColor: border,
    textColor: ink, lineColor: line, arrowheadColor: line,
    clusterBkg: soft, edgeLabelBackground: paper, noteBkgColor: note, noteTextColor: ink, noteBorderColor: noteBorder,
    actorLineColor: border, signalColor: line, activationBkgColor: node, activationBorderColor: nodeBorder,
    stateLabelColor: ink, relationLabelBackground: paper,
    rowOdd: paper, rowEven: soft, attributeBackgroundColorOdd: paper, attributeBackgroundColorEven: soft,
    altSectionBkgColor: paper, excludeBkgColor: soft, gridColor: border,
    doneTaskBkgColor: soft, doneTaskBorderColor: border, activeTaskBkgColor: node,
    critBkgColor: criticalFill, critBorderColor: critical, todayLineColor: series[0], vertLineColor: line,
    pieStrokeColor: paper, pieOuterStrokeColor: border, pieOpacity: '1',
    xyChart: { backgroundColor: 'transparent', plotColorPalette: series.join(',') },
    radar: { graticuleColor: border },
    wardleyEvolutionColor: critical, wardley: { backgroundColor: 'transparent' },
    cynefin: { complexBg: fills[1], complicatedBg: fills[2], chaoticBg: fills[0], clearBg: fills[3], confusionBg: fills[4], cliffColor: critical },
  };
  // Mermaid uses distinct numbered keys for different diagram families.
  for (const [index, color] of series.entries()) {
    const fill = fills[index];
    variables[`pie${index + 1}`] = fill;
    variables[`cScale${index}`] = fill;
    variables[`cScalePeer${index}`] = color;
    variables[`cScaleInv${index}`] = color;
    if (index < 8) {
      variables[`fillType${index}`] = fill;
      variables[`git${index}`] = color;
      variables[`gitInv${index}`] = ink;
      variables[`gitBranchLabel${index}`] = paper;
      variables[`venn${index + 1}`] = color;
    }
    if (index < 4) variables[`quadrant${index + 1}Fill`] = fill;
  }
  return variables;
}

export function mermaidRoleStyles() {
  const color = readColors();
  const paper = color('ui-bg');
  return ['support', 'detail'].map(role => {
    const stroke = color(`ui-${role}`);
    const fill = tint(stroke, paper, .18);
    return `.node.${role} > :is(rect, polygon, circle, ellipse, path, .label-container path) { fill: ${fill}; stroke: ${stroke}; }`;
  }).join('\n');
}
