import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTaskMetadata, specificationHash, taskClasses, validateExecutionContract } from '../src/task-classification.mjs';

const contract={scope:'Change labels',expectedResult:'Labels are updated',invariants:['Keep calculations'],areas:['src/card.mjs'],acceptanceCriteria:['No old label'],validationCommands:['npm test']};
const request=value=>`\n\n\`\`\`pilot-task\n${JSON.stringify(value)}\n\`\`\`\nDo the requested work.`;

test('task classification accepts all explicit classes and normalizes a complete contract',()=>{
  for(const taskClass of taskClasses) {
    const parsed=parseTaskMetadata(request({class:taskClass,executionContract:contract}));
    assert.equal(parsed.kind,'valid');
    assert.deepEqual(parsed.taskMetadata,{version:1,class:taskClass,executionContract:contract});
  }
  const complex=parseTaskMetadata(request({class:'complex',executionContract:contract}));
  assert.equal(complex.taskMetadata.class,'complex');
  assert.deepEqual(parseTaskMetadata(request({class:'routine'})),{kind:'valid',taskMetadata:{version:1,class:'routine',executionContract:null}});
});
test('task classification only reserves the first non-empty fence and rejects malformed reserved blocks',()=>{
  assert.deepEqual(parseTaskMetadata('Task prose\n```pilot-task\n{"class":"routine"}\n```'),{kind:'absent'});
  assert.deepEqual(parseTaskMetadata('```pilot-task\n{"class":"routine"}'),{kind:'invalid',error:'pilot-task-unclosed'});
  assert.deepEqual(parseTaskMetadata('```pilot-task\nnot json\n```'),{kind:'invalid',error:'pilot-task-json-invalid'});
  assert.deepEqual(parseTaskMetadata(request({class:'standard'})),{kind:'invalid',error:'pilot-task-schema-invalid'});
  assert.deepEqual(parseTaskMetadata(request({class:'routine',unknown:true})),{kind:'invalid',error:'pilot-task-schema-invalid'});
  assert.deepEqual(parseTaskMetadata(request({class:'routine',executionContract:{...contract,invariants:[]}})),{kind:'invalid',error:'pilot-task-schema-invalid'});
  assert.deepEqual(parseTaskMetadata(request({class:'routine',executionContract:{...contract,scope:'   '}})),{kind:'invalid',error:'pilot-task-schema-invalid'});
  assert.deepEqual(parseTaskMetadata(`\`\`\`pilot-task\n${JSON.stringify({class:'routine',padding:'é'.repeat(9000)})}\n\`\`\``),{kind:'invalid',error:'pilot-task-too-large'});
});
test('execution contracts reject unknown fields and hashes freeze the title and body exactly',()=>{
  assert.throws(()=>validateExecutionContract({...contract,unexpected:'x'}),/Invalid execution contract/);
  assert.throws(()=>validateExecutionContract({...contract,invariants:Array(1)}),/Invalid execution contract/);
  assert.deepEqual(validateExecutionContract({...contract,scope:'  Change labels  '}),contract);
  const issue={title:'Title',body:'Body'};
  assert.equal(specificationHash(issue),specificationHash({title:'Title',body:'Body'}));
  assert.notEqual(specificationHash(issue),specificationHash({title:'Changed',body:'Body'}));
  assert.notEqual(specificationHash(issue),specificationHash({title:'Title',body:'Changed'}));
});
