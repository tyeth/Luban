import assert from 'assert';
import vm from 'vm';
import { pendantPage } from '../pendantPage';

// Exercise the actual page script with inert HTTP and DOM surfaces; never contact a machine.
async function pageFixture() {
    const elements = new Map<string, Element>();
    class Element {
        public id = '';

        public value: string | number = '';

        public textContent = '';

        public step = '';

        public checked = false;

        public disabled = false;

        public onclick: (() => void | Promise<void>) | null = null;

        public onsubmit: ((event: { preventDefault: () => void }) => Promise<void>) | null = null;

        public oninput: (() => void) | null = null;

        public appendChild(child: Element) { if (child.id) { elements.set(child.id, child); } }

        public setAttribute() { /* Accessibility attributes do not affect these interactions. */ }

        public addEventListener() { /* Native form validation is not simulated here. */ }
    }
    const html = pendantPage('test-token');
    for (const match of html.matchAll(/id="([^"]+)"/g)) { elements.set(match[1], new Element()); }
    const element = (id: string): Element => {
        const found = elements.get(id);
        if (!found) { throw Error(`Missing page element ${id}`); }
        return found;
    };
    const state = { armed: false,
        neutral: false,
        busy: false,
        error: '',
        ports: [{ path: 'COM42' }],
        travelBounds: { xMin: -19, xMax: 330, yMin: 0, yMax: 342, zMin: 0, zMax: 328 },
        defaultBounds: { xMin: 119, xMax: 129, yMin: 198.328994873, yMax: 208.328994873, zMin: 280, zMax: 329 } };
    let refuse = false;
    const posted: Array<{ url: string; body: { bounds?: object } }> = [];
    let poll = () => undefined;
    const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
    assert.ok(script);
    vm.runInNewContext(script as string, {
        document: { hidden: false,
            getElementById: element,
            createElement: () => new Element(),
            addEventListener: () => undefined },
        setInterval: (callback: () => undefined) => { poll = callback; },
        fetch: async (url: string, options?: { body: string }) => {
            if (!options) { return { ok: true, json: async () => state }; }
            posted.push({ url, body: JSON.parse(options.body) });
            if (url.endsWith('/arm')) {
                if (refuse) { return { ok: false, json: async () => ({ error: 'arm refused: rotary clearance' }) }; }
                state.armed = true;
            }
            if (url.endsWith('/disarm')) { state.armed = false; }
            return { ok: true, json: async () => ({ ok: true }) };
        }
    });
    const settle = async () => new Promise<void>((resolve) => setImmediate(resolve));
    await settle();
    return { element,
        posted,
        state,
        refuse: () => { refuse = true; },
        refresh: async () => { poll(); await settle(); },
        arm: async () => { await element('envelope').onsubmit?.({ preventDefault: () => undefined }); } };
}

export const tests: Array<[string, () => Promise<void>]> = [
    ['machine-fill buttons are independent, invalidate consent and preview travel clipping', async () => {
        const f = await pageFixture();
        assert.equal(f.element('yMin').step, 'any');
        assert.equal(f.element('yMin').value, 198.329);
        assert.equal(f.element('zMin').value, 280);
        assert.equal(f.element('zMax').value, 329);
        f.element('clear').checked = true;
        await f.element('fill-x').onclick?.();
        assert.equal(f.element('xMin').value, -20);
        assert.equal(f.element('xMax').value, 331);
        assert.equal(f.element('yMin').value, 198.329);
        assert.equal(f.element('clear').checked, false);
        await f.element('fill-y').onclick?.();
        assert.equal(f.element('yMin').value, -1);
        assert.equal(f.element('yMax').value, 343);
        await f.element('fill-xy').onclick?.();
        assert.match(f.element('effective').textContent, /X -19.000 to 330.000/);
        assert.match(f.element('effective').textContent, /Z 280.000 to 328.000/);
        f.element('clear').checked = true;
        await f.arm();
        assert.ok(f.posted.some((request) => request.url === '/pendant/arm'));
        assert.equal(f.state.armed, true);
        assert.equal(f.element('review').disabled, true);
    }],
    ['refused arm stays visible through polls and Stop has explicit persistent acknowledgement', async () => {
        const f = await pageFixture();
        f.refuse(); await f.arm();
        await f.refresh(); await f.refresh();
        assert.match(f.element('action').textContent, /rotary clearance/);
        await f.element('stop').onclick?.();
        await f.refresh();
        assert.match(f.element('action').textContent, /Stop accepted. Disarmed/);
        assert.match(f.element('state').textContent, /DISARMED/);
        assert.equal(f.state.armed, false);
    }],
];
