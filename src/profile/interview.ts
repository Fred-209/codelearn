import * as vscode from 'vscode';
import type { Store } from '../store/store';
import type { LearnerProfile } from '../store/types';

// Suggestions only: the learner can add anything. Grouped so the list is scannable.
const SUGGESTIONS: Record<string, string[]> = {
  Languages: ['JavaScript', 'TypeScript', 'Python', 'Java', 'C#', 'Go', 'Rust', 'C', 'C++', 'Kotlin', 'Swift', 'Ruby', 'PHP', 'SQL'],
  'Frontend': ['HTML & CSS', 'React', 'Angular', 'Vue', 'Svelte', 'Redux', 'RxJS'],
  'Backend & frameworks': ['Node.js', 'Express', 'NestJS', 'ASP.NET Core', 'Spring', 'Django', 'Flask', 'FastAPI', 'Ruby on Rails', 'Laravel'],
  'Data': ['Relational databases', 'ORMs', 'REST APIs', 'GraphQL', 'Message queues', 'NoSQL databases'],
  'Concepts': [
    'Object-oriented programming',
    'Functional programming',
    'Async / promises',
    'Dependency injection',
    'Unit testing',
    'Design patterns',
    'MVC / MVVM',
    'Clean / layered architecture',
    'Git',
    'Docker',
  ],
};

export async function runInterview(store: Store): Promise<LearnerProfile | undefined> {
  const existing = store.getProfile();
  const picked = new Set(existing?.known ?? []);

  const items: (vscode.QuickPickItem & { value?: string })[] = [];
  for (const [group, names] of Object.entries(SUGGESTIONS)) {
    items.push({ label: group, kind: vscode.QuickPickItemKind.Separator });
    for (const name of names) items.push({ label: name, value: name, picked: picked.has(name) });
  }
  const extras = (existing?.known ?? []).filter((k) => !Object.values(SUGGESTIONS).flat().includes(k));

  const chosen = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: 'codelearn (1 of 3): What do you already know?',
    placeHolder: 'Pick everything you are comfortable with. This only sets where explanations start; everything stays available.',
    ignoreFocusOut: true,
  });
  if (!chosen) return undefined;

  const more = await vscode.window.showInputBox({
    title: 'codelearn (2 of 3): Anything else?',
    prompt: 'Other languages, libraries or concepts you know, separated by commas. Leave empty to skip.',
    value: extras.join(', '),
    ignoreFocusOut: true,
  });
  if (more === undefined) return undefined;

  const level = await vscode.window.showQuickPick(
    [
      { label: 'Professional developer', value: 'professional' as const },
      { label: 'Some programming experience', value: 'some' as const },
      { label: 'New to programming', value: 'new' as const },
    ],
    { title: 'codelearn (3 of 3): How much programming have you done?', ignoreFocusOut: true },
  );
  if (!level) return undefined;

  const known = [
    ...chosen.map((c) => c.value!).filter(Boolean),
    ...more.split(',').map((s) => s.trim()).filter(Boolean),
  ];
  const profile: LearnerProfile = {
    known: [...new Set(known)],
    experience: level.value,
    updatedAt: new Date().toISOString(),
  };
  await store.saveProfile(profile);
  vscode.window.showInformationMessage(
    `codelearn will explain things in terms of ${profile.known.slice(0, 4).join(', ') || 'general programming'}${profile.known.length > 4 ? ' and more' : ''}. Change this any time with "codelearn: Tell codelearn what you already know".`,
  );
  return profile;
}

/** Offers the interview once, the first time codelearn runs. */
export async function offerInterviewOnce(context: vscode.ExtensionContext, store: Store): Promise<void> {
  if (store.getProfile() || context.globalState.get('codelearn.interviewOffered')) return;
  await context.globalState.update('codelearn.interviewOffered', true);
  const choice = await vscode.window.showInformationMessage(
    'codelearn can tailor explanations to what you already know. It takes about a minute.',
    'Set up',
    'Later',
  );
  if (choice === 'Set up') await runInterview(store);
}
