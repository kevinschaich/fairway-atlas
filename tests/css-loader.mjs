// Under node --test, game modules' CSS imports (bundled by Vite) load as nothing.
import {registerHooks} from 'node:module';
registerHooks({load(url, context, next) {
	if (url.endsWith('.css')) return {format: 'module', source: '', shortCircuit: true};
	return next(url, context);
}});
