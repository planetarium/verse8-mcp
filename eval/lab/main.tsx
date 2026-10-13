import { createGame3D } from 'incanto/3d';
import { CharacterAnimator, FollowLight } from './behaviors';

const name = new URLSearchParams(location.search).get('s') ?? 'template';
const canvas = document.createElement('canvas');
canvas.id = 'game';
document.getElementById('root')!.replaceWith(canvas);
document.querySelector('#loading')?.remove();
document.querySelector('.action-buttons')?.remove();
(async () => {
  const scene = await (await fetch(`scenes/${name}.json`)).json();
  const game = await createGame3D({ canvas, scene, behaviors: { FollowLight, CharacterAnimator } });
  Object.assign(window, { game, labReady: true });
})().catch((e) => Object.assign(window, { labError: String(e) }));
