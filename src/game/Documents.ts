// Everything the player can read. Kept short: each page should earn its place.

export type Doc = { id: string; title: string; style: 'hand' | 'type' | 'print' | 'child' | 'log'; html: () => string };

const row = (t: string, s: string) => `<div class="row"><b>${t}</b><span>${s}</span></div>`;

export const DOCS: Record<string, Doc> = {
  workorder: {
    id: 'workorder',
    title: 'Work order',
    style: 'type',
    html: () => `
      <h2>HARROW COUNTY COMMUNICATIONS</h2>
      <p>WORK ORDER No. 4471 &nbsp;·&nbsp; PRIORITY: <span class="stamp">URGENT</span></p>
      <p>SITE: Blackwater relay / Hill St. substation<br>ISSUE: No carrier since Tue 04:17. All lines to Blackwater dead (phone, radio, power).</p>
      <p>ASSIGNED: Unit 7</p>
      <p>NOTES: Sheriff’s substation not answering. Coast Guard reports “tide gauge fault” at Blackwater station — ignore, not our equipment.</p>
      <p class="faded">Radio dispatch on arrival.</p>`,
  },
  sheriffLog: {
    id: 'sheriffLog',
    title: 'Deputy’s log',
    style: 'log',
    html: () => `
      <h2>Blackwater Substation — Daily Log</h2>
      ${row('TUE 04:21', 'Tide gauge alarm from Wren at the light. Water dropping fast. Called it in — county says sensor fault.')}
      ${row('04:40', 'It’s not a fault. Harbor is draining like a bathtub. Boats on the mud. Sounded the siren.')}
      ${row('05:05', 'Evacuating up Coast Rd per the tsunami plan. Everybody in cars.')}
      ${row('05:20', 'Spruce down across the road above the Hill St turn. Nobody can get past. Radio dead. Phones dead.')}
      ${row('05:48', 'People getting out of their cars. Walking back down. I asked Dale where he was going. He said, <i>“Can’t you hear it?”</i>')}
      ${row('06:10', 'I can hear it now.')}
      <p class="faded">(The rest of the page is blank.)</p>`,
  },
  lineman: {
    id: 'lineman',
    title: 'Note on the panel',
    style: 'hand',
    html: () => `
      <p>Tue 4:30 am —</p>
      <p>Main tripped. Feeder 3 faulted (harbor / tide stn line).</p>
      <p><b>DO NOT re-close F3.</b> Keeps shorting — water in the harbor vault??</p>
      <p>Open F3, then you can close the main.</p>
      <p style="text-align:right">— Walt</p>`,
  },
  dinerTicket: {
    id: 'dinerTicket',
    title: 'Order ticket',
    style: 'hand',
    html: () => `
      <p style="font-family:var(--mono);font-size:13px">THE ANCHOR · TABLE 4 · TUE</p>
      <p>2 coffee<br>eggs over easy / hash<br>short stack<br>1 hot choc (kid)</p>
      <p style="transform:rotate(-2deg)">Dale — Sheriff says everybody out, tsunami. Back in an hour. Leave the grill. — Bev</p>`,
  },
  fridge: {
    id: 'fridge',
    title: 'Note on the fridge',
    style: 'hand',
    html: () => `
      <p>Nora — </p>
      <p>Gone down to see the water with Dad. It’s nothing, honey. Stay in bed.</p>
      <p>Back by breakfast.</p>
      <p style="text-align:right">Love, Mom</p>`,
  },
  drawing: {
    id: 'drawing',
    title: 'Child’s drawing',
    style: 'child',
    html: () => `<canvas id="kid-drawing" width="520" height="360"></canvas><p style="text-align:center">EVRYBODY WENT TO SEE THE WATER</p>`,
  },
  tideChart: {
    id: 'tideChart',
    title: 'Tide chart',
    style: 'print',
    html: () => `
      <h2>Blackwater Harbor — Tide Gauge</h2>
      <canvas id="tide-chart" width="520" height="260"></canvas>
      <p style="font-family:var(--mono);font-size:13px">Scale: feet above MLLW. Pen trace, 1 hr / div.</p>
      <p class="faded" style="font-family:var(--hand);font-size:18px;color:#1f2a44">4:17 — pen off the bottom of the chart. Re-zeroed twice. It’s still going down. — H.M.</p>`,
  },
  journal1: {
    id: 'journal1',
    title: 'Keeper’s journal',
    style: 'hand',
    html: () => `
      <p><b>Oct 19.</b> The tide went out at 4:17 and didn’t stop. By first light the water was a silver line at the edge of the world. The gauge reads eleven feet below datum and falling.</p>
      <p>That is not a tide.</p>
      <p><b>Oct 20.</b> The town heard it last night. A low note from out on the flats, like the horn, but coming from the wrong direction. Dale says it’s the cannery pipes. Dale knows better.</p>`,
  },
  journal2: {
    id: 'journal2',
    title: 'Keeper’s journal',
    style: 'hand',
    html: () => `
      <p><b>Oct 21.</b> They tried to leave. From up here I watched their headlights climb the hill and stop at the big spruce.</p>
      <p>Then the lights started coming back down. On foot. Past the church, down Main Street, down the slipway, out onto the mud — lanterns and flashlights in a long line, like a procession.</p>
      <p>I kept the light going so they could find their way home.</p>
      <p><b>Oct 22.</b> I’ve set the tide recorder to keep broadcasting. If anyone comes: stay off the flats. Don’t follow the lights.</p>`,
  },
  journal3: {
    id: 'journal3',
    title: 'Last page',
    style: 'hand',
    html: () => `
      <p>The motor stopped again. I’ve left the lamp lit.</p>
      <p>I don’t think it’s taking them. I think it’s <i>waiting</i> — holding the whole sea back like a breath.</p>
      <p>Somebody has to go out and bring them home before it lets go.</p>
      <p style="text-align:right">— W.</p>`,
  },
  wrenLetter: {
    id: 'wrenLetter',
    title: 'Postcard',
    style: 'hand',
    html: () => `
      <p style="font-family:var(--mono);font-size:12px">GREETINGS FROM BLACKWATER BAY — “WHERE THE FOG COMES HOME”</p>
      <p>Mom — the new keeper’s house has a stove that actually works. The light is beautiful. Some nights the fog comes in so thick the beam looks solid, like you could walk out on it.</p>
      <p>The town is small and kind. They leave fish on my step.</p>
      <p>— Wren</p>`,
  },
  church: {
    id: 'church',
    title: 'Hymn board',
    style: 'print',
    html: () => `
      <h2>Sunday Oct 17</h2>
      <p>Hymn 318 · “Eternal Father, Strong to Save”</p>
      <p>Hymn 211</p>
      <p>Prayers for the fleet</p>
      <p class="faded">Someone has chalked underneath, in a child’s hand: <i>“for those in peril on the sea”</i></p>`,
  },
};

/** Draw the child's crayon picture: stick figures walking toward a tall blue shape. */
export function drawKidPicture(c: HTMLCanvasElement) {
  const g = c.getContext('2d')!;
  g.fillStyle = '#f4efe2';
  g.fillRect(0, 0, c.width, c.height);
  const crayon = (color: string, w: number, pts: [number, number][]) => {
    g.strokeStyle = color;
    g.lineWidth = w;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.beginPath();
    pts.forEach(([x, y], i) => {
      const jx = x + (Math.random() - 0.5) * 2,
        jy = y + (Math.random() - 0.5) * 2;
      if (i === 0) g.moveTo(jx, jy);
      else g.lineTo(jx, jy);
    });
    g.stroke();
  };
  // ground
  crayon('#7a5a3a', 6, [[10, 280], [510, 270]]);
  // the "water" standing up like a wall
  for (let i = 0; i < 40; i++) crayon('#2a55b5', 5, [[330 + i * 4, 270], [335 + i * 4, 40 + Math.sin(i) * 6]]);
  // sun
  g.fillStyle = '#f2b72c';
  g.beginPath();
  g.arc(470, 50, 26, 0, Math.PI * 2);
  g.fill();
  // figures walking right
  const fig = (x: number, s: number, col: string) => {
    crayon(col, 4, [[x, 270], [x + 8 * s, 240 * 1], [x + 16 * s, 270]]);
    crayon(col, 4, [[x + 8 * s, 240], [x + 8 * s, 205]]);
    crayon(col, 4, [[x - 4 * s, 222], [x + 8 * s, 214], [x + 20 * s, 222]]);
    g.strokeStyle = col;
    g.lineWidth = 4;
    g.beginPath();
    g.arc(x + 8 * s, 193, 11 * s, 0, Math.PI * 2);
    g.stroke();
  };
  [40, 90, 140, 190, 240, 290].forEach((x, i) => fig(x, i === 2 ? 0.7 : 1, ['#222', '#b52a2a', '#2a8a3a', '#222', '#6a2ab5', '#222'][i]));
  // a small figure left behind in a window
  g.strokeStyle = '#222';
  g.lineWidth = 3;
  g.strokeRect(20, 60, 70, 60);
  crayon('#222', 3, [[55, 120], [55, 95]]);
  g.beginPath();
  g.arc(55, 86, 8, 0, Math.PI * 2);
  g.stroke();
  crayon('#222', 3, [[30, 140], [80, 140]]);
  g.fillStyle = '#222';
  g.font = "22px 'Kalam', cursive";
  g.fillText('ME', 40, 160);
}

export function drawTideChart(c: HTMLCanvasElement) {
  const g = c.getContext('2d')!;
  g.fillStyle = '#f5f0e2';
  g.fillRect(0, 0, c.width, c.height);
  g.strokeStyle = 'rgba(120,150,160,0.5)';
  g.lineWidth = 1;
  for (let x = 0; x < c.width; x += 26) {
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, c.height);
    g.stroke();
  }
  for (let y = 0; y < c.height; y += 26) {
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(c.width, y);
    g.stroke();
  }
  g.strokeStyle = '#2a3f8a';
  g.lineWidth = 2;
  g.beginPath();
  for (let x = 0; x < c.width; x++) {
    const t = x / 26; // hours
    let y = 130 - Math.sin((t / 12.4) * Math.PI * 2 + 1.2) * 60;
    if (t > 13.5) y += (t - 13.5) * (t - 13.5) * 38;
    y = Math.min(y, c.height - 2);
    if (x === 0) g.moveTo(x, y);
    else g.lineTo(x, y + (Math.random() - 0.5) * 0.8);
  }
  g.stroke();
  g.fillStyle = '#8e2c22';
  g.font = '12px Courier Prime, monospace';
  g.fillText('04:17', 13.5 * 26 - 16, 20);
}
