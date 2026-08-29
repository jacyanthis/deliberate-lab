import {createExperimentConfig, createExperimentTemplate} from './experiment';

describe('createExperimentConfig', () => {
  it('keeps a field it has never heard of', () => {
    const experiment = createExperimentConfig([], {
      banana: 'yellow',
    } as never);
    expect((experiment as unknown as Record<string, unknown>).banana).toBe(
      'yellow',
    );
  });

  it('keeps the optional fields that were passed in', () => {
    const experiment = createExperimentConfig([], {
      cohortDefinitions: [],
      variableConfigs: [],
    });
    expect(experiment.cohortDefinitions).toEqual([]);
    expect(experiment.variableConfigs).toEqual([]);
  });

  it('still decides the values it is responsible for', () => {
    const experiment = createExperimentConfig([], {
      id: '',
      variableMap: undefined,
    } as never);
    expect(experiment.id).not.toBe('');
    expect(experiment.variableMap).toEqual({});
    expect(experiment.metadata).toBeDefined();
    expect(experiment.prolificConfig).toBeDefined();
  });
});

describe('reopening an experiment', () => {
  // What the experiment editor does when it opens an experiment: every field
  // is handed over and only the id is replaced, because a new experiment
  // built from an existing one needs its own. Nothing may be lost in between,
  // however recently the field was added.
  const opened = (fields: Record<string, unknown>, keepId = false) => {
    const original = createExperimentConfig([], fields as never);
    return {
      original,
      reopened: createExperimentConfig([], {
        ...original,
        id: keepId ? original.id : '',
      } as never),
    };
  };

  it('keeps a field nobody has heard of', () => {
    const {reopened} = opened({banana: 'yellow'});
    expect((reopened as unknown as Record<string, unknown>).banana).toBe(
      'yellow',
    );
  });

  it('gives a new experiment its own id, and keeps it when editing', () => {
    const fresh = opened({});
    expect(fresh.reopened.id).not.toBe(fresh.original.id);
    const editing = opened({}, true);
    expect(editing.reopened.id).toBe(editing.original.id);
  });
});

describe('createExperimentTemplate', () => {
  it('keeps a field it has never heard of', () => {
    const template = createExperimentTemplate({banana: 'yellow'} as never);
    expect((template as unknown as Record<string, unknown>).banana).toBe(
      'yellow',
    );
  });
});
