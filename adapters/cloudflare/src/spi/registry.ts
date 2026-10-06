import { createDefaultClassifiers } from '../classifiers';
import type { CloudflareBindingInfo } from '../types';
import type { CloudflareBindingClassifier } from './classifier';

export class BindingClassifierRegistry {
  private classifiers: CloudflareBindingClassifier[] = [];

  constructor(registerDefaults = true) {
    if (registerDefaults) {
      this.classifiers.push(...createDefaultClassifiers());
    }
  }

  /**
   * Registers a classifier. `high` (the default) is checked before the built-ins.
   */
  register(
    classifier: CloudflareBindingClassifier,
    options: { priority?: 'high' | 'low' } = { priority: 'high' },
  ): this {
    if (options.priority === 'low') {
      this.classifiers.push(classifier);
    } else {
      this.classifiers.unshift(classifier);
    }
    return this;
  }

  findClassifier(name: string, value: unknown): CloudflareBindingClassifier | undefined {
    return this.classifiers.find((classifier) => {
      try {
        return classifier.accept(name, value);
      } catch {
        return false;
      }
    });
  }

  classify(name: string, value: unknown): CloudflareBindingInfo {
    const classifier = this.findClassifier(name, value);
    if (!classifier) {
      return { name, kind: 'unknown', binding: value };
    }
    return classifier.create(name, value);
  }
}

let defaultRegistry: BindingClassifierRegistry | null = null;

export function getDefaultRegistry(): BindingClassifierRegistry {
  if (!defaultRegistry) {
    defaultRegistry = new BindingClassifierRegistry();
  }
  return defaultRegistry;
}

export function resetDefaultRegistry(): void {
  defaultRegistry = null;
}
