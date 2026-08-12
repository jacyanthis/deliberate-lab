import {Value} from '@sinclair/typebox/value';
import {createExperimentConfig, createExperimentTemplate} from './experiment';
import {ExperimentTemplateSchema} from './experiment.validation';

describe('createExperimentConfig', () => {
  it('should keep the turn-based timeout settings that were passed in', () => {
    const experiment = createExperimentConfig([], {
      timeoutMessageLimit: 3,
      useNeutralTimeoutResponses: true,
    });
    expect(experiment.timeoutMessageLimit).toBe(3);
    expect(experiment.useNeutralTimeoutResponses).toBe(true);
  });

  it('should keep an explicit null limit, which means no limit', () => {
    const experiment = createExperimentConfig([], {timeoutMessageLimit: null});
    expect(experiment.timeoutMessageLimit).toBeNull();
  });

  it('should leave both unset when they were not passed in', () => {
    const experiment = createExperimentConfig([]);
    expect(experiment.timeoutMessageLimit).toBeUndefined();
    expect(experiment.useNeutralTimeoutResponses).toBeUndefined();
  });
});

describe('autoAcceptTransfers', () => {
  test('is undefined unless it is set', () => {
    expect(createExperimentConfig().autoAcceptTransfers).toBeUndefined();
  });

  test('survives a rebuild of the config', () => {
    const config = createExperimentConfig([], {autoAcceptTransfers: true});
    expect(config.autoAcceptTransfers).toBe(true);
    expect(createExperimentConfig([], config).autoAcceptTransfers).toBe(true);
  });

  test('passes validation whether set or absent', () => {
    const set = createExperimentTemplate({
      experiment: createExperimentConfig([], {autoAcceptTransfers: true}),
    });
    const absent = createExperimentTemplate({
      experiment: createExperimentConfig(),
    });
    expect(Value.Check(ExperimentTemplateSchema, set)).toBe(true);
    expect(Value.Check(ExperimentTemplateSchema, absent)).toBe(true);
  });
});
