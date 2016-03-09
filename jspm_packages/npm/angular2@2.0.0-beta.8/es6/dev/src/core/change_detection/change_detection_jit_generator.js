/* */ 
"format cjs";
import { assertionsEnabled, isBlank } from 'angular2/src/facade/lang';
import { BaseException } from 'angular2/src/facade/exceptions';
import { ListWrapper } from 'angular2/src/facade/collection';
import { AbstractChangeDetector } from './abstract_change_detector';
import { ChangeDetectionUtil } from './change_detection_util';
import { RecordType } from './proto_record';
import { CodegenNameUtil, sanitizeName } from './codegen_name_util';
import { CodegenLogicUtil } from './codegen_logic_util';
import { codify } from './codegen_facade';
import { ChangeDetectorState } from './constants';
import { createPropertyRecords, createEventRecords } from './proto_change_detector';
/**
 * The code generator takes a list of proto records and creates a function/class
 * that "emulates" what the developer would write by hand to implement the same
 * kind of behaviour.
 *
 * This code should be kept in sync with the Dart transformer's
 * `angular2.transform.template_compiler.change_detector_codegen` library. If you make updates
 * here, please make equivalent changes there.
*/
const IS_CHANGED_LOCAL = "isChanged";
const CHANGES_LOCAL = "changes";
export class ChangeDetectorJITGenerator {
    constructor(definition, changeDetectionUtilVarName, abstractChangeDetectorVarName, changeDetectorStateVarName) {
        this.changeDetectionUtilVarName = changeDetectionUtilVarName;
        this.abstractChangeDetectorVarName = abstractChangeDetectorVarName;
        this.changeDetectorStateVarName = changeDetectorStateVarName;
        var propertyBindingRecords = createPropertyRecords(definition);
        var eventBindingRecords = createEventRecords(definition);
        var propertyBindingTargets = definition.bindingRecords.map(b => b.target);
        this.id = definition.id;
        this.changeDetectionStrategy = definition.strategy;
        this.genConfig = definition.genConfig;
        this.records = propertyBindingRecords;
        this.propertyBindingTargets = propertyBindingTargets;
        this.eventBindings = eventBindingRecords;
        this.directiveRecords = definition.directiveRecords;
        this._names = new CodegenNameUtil(this.records, this.eventBindings, this.directiveRecords, this.changeDetectionUtilVarName);
        this._logic = new CodegenLogicUtil(this._names, this.changeDetectionUtilVarName, this.changeDetectorStateVarName);
        this.typeName = sanitizeName(`ChangeDetector_${this.id}`);
    }
    generate() {
        var factorySource = `
      ${this.generateSource()}
      return function() {
        return new ${this.typeName}();
      }
    `;
        return new Function(this.abstractChangeDetectorVarName, this.changeDetectionUtilVarName, this.changeDetectorStateVarName, factorySource)(AbstractChangeDetector, ChangeDetectionUtil, ChangeDetectorState);
    }
    generateSource() {
        return `
      var ${this.typeName} = function ${this.typeName}() {
        ${this.abstractChangeDetectorVarName}.call(
            this, ${JSON.stringify(this.id)}, ${this.records.length},
            ${this.typeName}.gen_propertyBindingTargets, ${this.typeName}.gen_directiveIndices,
            ${codify(this.changeDetectionStrategy)});
        this.dehydrateDirectives(false);
      }

      ${this.typeName}.prototype = Object.create(${this.abstractChangeDetectorVarName}.prototype);

      ${this.typeName}.prototype.detectChangesInRecordsInternal = function(throwOnChange) {
        ${this._names.genInitLocals()}
        var ${IS_CHANGED_LOCAL} = false;
        var ${CHANGES_LOCAL} = null;

        ${this._genAllRecords(this.records)}
      }

      ${this._maybeGenHandleEventInternal()}

      ${this._maybeGenAfterContentLifecycleCallbacks()}

      ${this._maybeGenAfterViewLifecycleCallbacks()}

      ${this._maybeGenHydrateDirectives()}

      ${this._maybeGenDehydrateDirectives()}

      ${this._genPropertyBindingTargets()}

      ${this._genDirectiveIndices()}
    `;
    }
    /** @internal */
    _genPropertyBindingTargets() {
        var targets = this._logic.genPropertyBindingTargets(this.propertyBindingTargets, this.genConfig.genDebugInfo);
        return `${this.typeName}.gen_propertyBindingTargets = ${targets};`;
    }
    /** @internal */
    _genDirectiveIndices() {
        var indices = this._logic.genDirectiveIndices(this.directiveRecords);
        return `${this.typeName}.gen_directiveIndices = ${indices};`;
    }
    /** @internal */
    _maybeGenHandleEventInternal() {
        if (this.eventBindings.length > 0) {
            var handlers = this.eventBindings.map(eb => this._genEventBinding(eb)).join("\n");
            return `
        ${this.typeName}.prototype.handleEventInternal = function(eventName, elIndex, locals) {
          var ${this._names.getPreventDefaultAccesor()} = false;
          ${this._names.genInitEventLocals()}
          ${handlers}
          return ${this._names.getPreventDefaultAccesor()};
        }
      `;
        }
        else {
            return '';
        }
    }
    /** @internal */
    _genEventBinding(eb) {
        let codes = [];
        this._endOfBlockIdxs = [];
        ListWrapper.forEachWithIndex(eb.records, (r, i) => {
            let code;
            if (r.isConditionalSkipRecord()) {
                code = this._genConditionalSkip(r, this._names.getEventLocalName(eb, i));
            }
            else if (r.isUnconditionalSkipRecord()) {
                code = this._genUnconditionalSkip(r);
            }
            else {
                code = this._genEventBindingEval(eb, r);
            }
            code += this._genEndOfSkipBlock(i);
            codes.push(code);
        });
        return `
    if (eventName === "${eb.eventName}" && elIndex === ${eb.elIndex}) {
      ${codes.join("\n")}
    }`;
    }
    /** @internal */
    _genEventBindingEval(eb, r) {
        if (r.lastInBinding) {
            var evalRecord = this._logic.genEventBindingEvalValue(eb, r);
            var markPath = this._genMarkPathToRootAsCheckOnce(r);
            var prevDefault = this._genUpdatePreventDefault(eb, r);
            return `${markPath}\n${evalRecord}\n${prevDefault}`;
        }
        else {
            return this._logic.genEventBindingEvalValue(eb, r);
        }
    }
    /** @internal */
    _genMarkPathToRootAsCheckOnce(r) {
        var br = r.bindingRecord;
        if (br.isDefaultChangeDetection()) {
            return "";
        }
        else {
            return `${this._names.getDetectorName(br.directiveRecord.directiveIndex)}.markPathToRootAsCheckOnce();`;
        }
    }
    /** @internal */
    _genUpdatePreventDefault(eb, r) {
        var local = this._names.getEventLocalName(eb, r.selfIndex);
        return `if (${local} === false) { ${this._names.getPreventDefaultAccesor()} = true};`;
    }
    /** @internal */
    _maybeGenDehydrateDirectives() {
        var destroyPipesCode = this._names.genPipeOnDestroy();
        var destroyDirectivesCode = this._logic.genDirectivesOnDestroy(this.directiveRecords);
        var dehydrateFieldsCode = this._names.genDehydrateFields();
        if (!destroyPipesCode && !destroyDirectivesCode && !dehydrateFieldsCode)
            return '';
        return `${this.typeName}.prototype.dehydrateDirectives = function(destroyPipes) {
        if (destroyPipes) {
          ${destroyPipesCode}
          ${destroyDirectivesCode}
        }
        ${dehydrateFieldsCode}
    }`;
    }
    /** @internal */
    _maybeGenHydrateDirectives() {
        var hydrateDirectivesCode = this._logic.genHydrateDirectives(this.directiveRecords);
        var hydrateDetectorsCode = this._logic.genHydrateDetectors(this.directiveRecords);
        if (!hydrateDirectivesCode && !hydrateDetectorsCode)
            return '';
        return `${this.typeName}.prototype.hydrateDirectives = function(directives) {
      ${hydrateDirectivesCode}
      ${hydrateDetectorsCode}
    }`;
    }
    /** @internal */
    _maybeGenAfterContentLifecycleCallbacks() {
        var notifications = this._logic.genContentLifecycleCallbacks(this.directiveRecords);
        if (notifications.length > 0) {
            var directiveNotifications = notifications.join("\n");
            return `
        ${this.typeName}.prototype.afterContentLifecycleCallbacksInternal = function() {
          ${directiveNotifications}
        }
      `;
        }
        else {
            return '';
        }
    }
    /** @internal */
    _maybeGenAfterViewLifecycleCallbacks() {
        var notifications = this._logic.genViewLifecycleCallbacks(this.directiveRecords);
        if (notifications.length > 0) {
            var directiveNotifications = notifications.join("\n");
            return `
        ${this.typeName}.prototype.afterViewLifecycleCallbacksInternal = function() {
          ${directiveNotifications}
        }
      `;
        }
        else {
            return '';
        }
    }
    /** @internal */
    _genAllRecords(rs) {
        var codes = [];
        this._endOfBlockIdxs = [];
        for (let i = 0; i < rs.length; i++) {
            let code;
            let r = rs[i];
            if (r.isLifeCycleRecord()) {
                code = this._genDirectiveLifecycle(r);
            }
            else if (r.isPipeRecord()) {
                code = this._genPipeCheck(r);
            }
            else if (r.isConditionalSkipRecord()) {
                code = this._genConditionalSkip(r, this._names.getLocalName(r.contextIndex));
            }
            else if (r.isUnconditionalSkipRecord()) {
                code = this._genUnconditionalSkip(r);
            }
            else {
                code = this._genReferenceCheck(r);
            }
            code = `
        ${this._maybeFirstInBinding(r)}
        ${code}
        ${this._maybeGenLastInDirective(r)}
        ${this._genEndOfSkipBlock(i)}
      `;
            codes.push(code);
        }
        return codes.join("\n");
    }
    /** @internal */
    _genConditionalSkip(r, condition) {
        let maybeNegate = r.mode === RecordType.SkipRecordsIf ? '!' : '';
        this._endOfBlockIdxs.push(r.fixedArgs[0] - 1);
        return `if (${maybeNegate}${condition}) {`;
    }
    /** @internal */
    _genUnconditionalSkip(r) {
        this._endOfBlockIdxs.pop();
        this._endOfBlockIdxs.push(r.fixedArgs[0] - 1);
        return `} else {`;
    }
    /** @internal */
    _genEndOfSkipBlock(protoIndex) {
        if (!ListWrapper.isEmpty(this._endOfBlockIdxs)) {
            let endOfBlock = ListWrapper.last(this._endOfBlockIdxs);
            if (protoIndex === endOfBlock) {
                this._endOfBlockIdxs.pop();
                return '}';
            }
        }
        return '';
    }
    /** @internal */
    _genDirectiveLifecycle(r) {
        if (r.name === "DoCheck") {
            return this._genOnCheck(r);
        }
        else if (r.name === "OnInit") {
            return this._genOnInit(r);
        }
        else if (r.name === "OnChanges") {
            return this._genOnChange(r);
        }
        else {
            throw new BaseException(`Unknown lifecycle event '${r.name}'`);
        }
    }
    /** @internal */
    _genPipeCheck(r) {
        var context = this._names.getLocalName(r.contextIndex);
        var argString = r.args.map((arg) => this._names.getLocalName(arg)).join(", ");
        var oldValue = this._names.getFieldName(r.selfIndex);
        var newValue = this._names.getLocalName(r.selfIndex);
        var pipe = this._names.getPipeName(r.selfIndex);
        var pipeName = r.name;
        var init = `
      if (${pipe} === ${this.changeDetectionUtilVarName}.uninitialized) {
        ${pipe} = ${this._names.getPipesAccessorName()}.get('${pipeName}');
      }
    `;
        var read = `${newValue} = ${pipe}.pipe.transform(${context}, [${argString}]);`;
        var contexOrArgCheck = r.args.map((a) => this._names.getChangeName(a));
        contexOrArgCheck.push(this._names.getChangeName(r.contextIndex));
        var condition = `!${pipe}.pure || (${contexOrArgCheck.join(" || ")})`;
        var check = `
      ${this._genThrowOnChangeCheck(oldValue, newValue)}
      if (${this.changeDetectionUtilVarName}.looseNotIdentical(${oldValue}, ${newValue})) {
        ${newValue} = ${this.changeDetectionUtilVarName}.unwrapValue(${newValue})
        ${this._genChangeMarker(r)}
        ${this._genUpdateDirectiveOrElement(r)}
        ${this._genAddToChanges(r)}
        ${oldValue} = ${newValue};
      }
    `;
        var genCode = r.shouldBeChecked() ? `${read}${check}` : read;
        if (r.isUsedByOtherRecord()) {
            return `${init} if (${condition}) { ${genCode} } else { ${newValue} = ${oldValue}; }`;
        }
        else {
            return `${init} if (${condition}) { ${genCode} }`;
        }
    }
    /** @internal */
    _genReferenceCheck(r) {
        var oldValue = this._names.getFieldName(r.selfIndex);
        var newValue = this._names.getLocalName(r.selfIndex);
        var read = `
      ${this._logic.genPropertyBindingEvalValue(r)}
    `;
        var check = `
      ${this._genThrowOnChangeCheck(oldValue, newValue)}
      if (${this.changeDetectionUtilVarName}.looseNotIdentical(${oldValue}, ${newValue})) {
        ${this._genChangeMarker(r)}
        ${this._genUpdateDirectiveOrElement(r)}
        ${this._genAddToChanges(r)}
        ${oldValue} = ${newValue};
      }
    `;
        var genCode = r.shouldBeChecked() ? `${read}${check}` : read;
        if (r.isPureFunction()) {
            var condition = r.args.map((a) => this._names.getChangeName(a)).join(" || ");
            if (r.isUsedByOtherRecord()) {
                return `if (${condition}) { ${genCode} } else { ${newValue} = ${oldValue}; }`;
            }
            else {
                return `if (${condition}) { ${genCode} }`;
            }
        }
        else {
            return genCode;
        }
    }
    /** @internal */
    _genChangeMarker(r) {
        return r.argumentToPureFunction ? `${this._names.getChangeName(r.selfIndex)} = true` : ``;
    }
    /** @internal */
    _genUpdateDirectiveOrElement(r) {
        if (!r.lastInBinding)
            return "";
        var newValue = this._names.getLocalName(r.selfIndex);
        var notifyDebug = this.genConfig.logBindingUpdate ? `this.logBindingUpdate(${newValue});` : "";
        var br = r.bindingRecord;
        if (br.target.isDirective()) {
            var directiveProperty = `${this._names.getDirectiveName(br.directiveRecord.directiveIndex)}.${br.target.name}`;
            return `
        ${directiveProperty} = ${newValue};
        ${notifyDebug}
        ${IS_CHANGED_LOCAL} = true;
      `;
        }
        else {
            return `
        this.notifyDispatcher(${newValue});
        ${notifyDebug}
      `;
        }
    }
    /** @internal */
    _genThrowOnChangeCheck(oldValue, newValue) {
        if (assertionsEnabled()) {
            return `
        if (throwOnChange && !${this.changeDetectionUtilVarName}.devModeEqual(${oldValue}, ${newValue})) {
          this.throwOnChangeError(${oldValue}, ${newValue});
        }
        `;
        }
        else {
            return '';
        }
    }
    /** @internal */
    _genAddToChanges(r) {
        var newValue = this._names.getLocalName(r.selfIndex);
        var oldValue = this._names.getFieldName(r.selfIndex);
        if (!r.bindingRecord.callOnChanges())
            return "";
        return `${CHANGES_LOCAL} = this.addChange(${CHANGES_LOCAL}, ${oldValue}, ${newValue});`;
    }
    /** @internal */
    _maybeFirstInBinding(r) {
        var prev = ChangeDetectionUtil.protoByIndex(this.records, r.selfIndex - 1);
        var firstInBinding = isBlank(prev) || prev.bindingRecord !== r.bindingRecord;
        return firstInBinding && !r.bindingRecord.isDirectiveLifecycle() ?
            `${this._names.getPropertyBindingIndex()} = ${r.propertyBindingIndex};` :
            '';
    }
    /** @internal */
    _maybeGenLastInDirective(r) {
        if (!r.lastInDirective)
            return "";
        return `
      ${CHANGES_LOCAL} = null;
      ${this._genNotifyOnPushDetectors(r)}
      ${IS_CHANGED_LOCAL} = false;
    `;
    }
    /** @internal */
    _genOnCheck(r) {
        var br = r.bindingRecord;
        return `if (!throwOnChange) ${this._names.getDirectiveName(br.directiveRecord.directiveIndex)}.ngDoCheck();`;
    }
    /** @internal */
    _genOnInit(r) {
        var br = r.bindingRecord;
        return `if (!throwOnChange && ${this._names.getStateName()} === ${this.changeDetectorStateVarName}.NeverChecked) ${this._names.getDirectiveName(br.directiveRecord.directiveIndex)}.ngOnInit();`;
    }
    /** @internal */
    _genOnChange(r) {
        var br = r.bindingRecord;
        return `if (!throwOnChange && ${CHANGES_LOCAL}) ${this._names.getDirectiveName(br.directiveRecord.directiveIndex)}.ngOnChanges(${CHANGES_LOCAL});`;
    }
    /** @internal */
    _genNotifyOnPushDetectors(r) {
        var br = r.bindingRecord;
        if (!r.lastInDirective || br.isDefaultChangeDetection())
            return "";
        var retVal = `
      if(${IS_CHANGED_LOCAL}) {
        ${this._names.getDetectorName(br.directiveRecord.directiveIndex)}.markAsCheckOnce();
      }
    `;
        return retVal;
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2hhbmdlX2RldGVjdGlvbl9qaXRfZ2VuZXJhdG9yLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiYW5ndWxhcjIvc3JjL2NvcmUvY2hhbmdlX2RldGVjdGlvbi9jaGFuZ2VfZGV0ZWN0aW9uX2ppdF9nZW5lcmF0b3IudHMiXSwibmFtZXMiOlsiQ2hhbmdlRGV0ZWN0b3JKSVRHZW5lcmF0b3IiLCJDaGFuZ2VEZXRlY3RvckpJVEdlbmVyYXRvci5jb25zdHJ1Y3RvciIsIkNoYW5nZURldGVjdG9ySklUR2VuZXJhdG9yLmdlbmVyYXRlIiwiQ2hhbmdlRGV0ZWN0b3JKSVRHZW5lcmF0b3IuZ2VuZXJhdGVTb3VyY2UiLCJDaGFuZ2VEZXRlY3RvckpJVEdlbmVyYXRvci5fZ2VuUHJvcGVydHlCaW5kaW5nVGFyZ2V0cyIsIkNoYW5nZURldGVjdG9ySklUR2VuZXJhdG9yLl9nZW5EaXJlY3RpdmVJbmRpY2VzIiwiQ2hhbmdlRGV0ZWN0b3JKSVRHZW5lcmF0b3IuX21heWJlR2VuSGFuZGxlRXZlbnRJbnRlcm5hbCIsIkNoYW5nZURldGVjdG9ySklUR2VuZXJhdG9yLl9nZW5FdmVudEJpbmRpbmciLCJDaGFuZ2VEZXRlY3RvckpJVEdlbmVyYXRvci5fZ2VuRXZlbnRCaW5kaW5nRXZhbCIsIkNoYW5nZURldGVjdG9ySklUR2VuZXJhdG9yLl9nZW5NYXJrUGF0aFRvUm9vdEFzQ2hlY2tPbmNlIiwiQ2hhbmdlRGV0ZWN0b3JKSVRHZW5lcmF0b3IuX2dlblVwZGF0ZVByZXZlbnREZWZhdWx0IiwiQ2hhbmdlRGV0ZWN0b3JKSVRHZW5lcmF0b3IuX21heWJlR2VuRGVoeWRyYXRlRGlyZWN0aXZlcyIsIkNoYW5nZURldGVjdG9ySklUR2VuZXJhdG9yLl9tYXliZUdlbkh5ZHJhdGVEaXJlY3RpdmVzIiwiQ2hhbmdlRGV0ZWN0b3JKSVRHZW5lcmF0b3IuX21heWJlR2VuQWZ0ZXJDb250ZW50TGlmZWN5Y2xlQ2FsbGJhY2tzIiwiQ2hhbmdlRGV0ZWN0b3JKSVRHZW5lcmF0b3IuX21heWJlR2VuQWZ0ZXJWaWV3TGlmZWN5Y2xlQ2FsbGJhY2tzIiwiQ2hhbmdlRGV0ZWN0b3JKSVRHZW5lcmF0b3IuX2dlbkFsbFJlY29yZHMiLCJDaGFuZ2VEZXRlY3RvckpJVEdlbmVyYXRvci5fZ2VuQ29uZGl0aW9uYWxTa2lwIiwiQ2hhbmdlRGV0ZWN0b3JKSVRHZW5lcmF0b3IuX2dlblVuY29uZGl0aW9uYWxTa2lwIiwiQ2hhbmdlRGV0ZWN0b3JKSVRHZW5lcmF0b3IuX2dlbkVuZE9mU2tpcEJsb2NrIiwiQ2hhbmdlRGV0ZWN0b3JKSVRHZW5lcmF0b3IuX2dlbkRpcmVjdGl2ZUxpZmVjeWNsZSIsIkNoYW5nZURldGVjdG9ySklUR2VuZXJhdG9yLl9nZW5QaXBlQ2hlY2siLCJDaGFuZ2VEZXRlY3RvckpJVEdlbmVyYXRvci5fZ2VuUmVmZXJlbmNlQ2hlY2siLCJDaGFuZ2VEZXRlY3RvckpJVEdlbmVyYXRvci5fZ2VuQ2hhbmdlTWFya2VyIiwiQ2hhbmdlRGV0ZWN0b3JKSVRHZW5lcmF0b3IuX2dlblVwZGF0ZURpcmVjdGl2ZU9yRWxlbWVudCIsIkNoYW5nZURldGVjdG9ySklUR2VuZXJhdG9yLl9nZW5UaHJvd09uQ2hhbmdlQ2hlY2siLCJDaGFuZ2VEZXRlY3RvckpJVEdlbmVyYXRvci5fZ2VuQWRkVG9DaGFuZ2VzIiwiQ2hhbmdlRGV0ZWN0b3JKSVRHZW5lcmF0b3IuX21heWJlRmlyc3RJbkJpbmRpbmciLCJDaGFuZ2VEZXRlY3RvckpJVEdlbmVyYXRvci5fbWF5YmVHZW5MYXN0SW5EaXJlY3RpdmUiLCJDaGFuZ2VEZXRlY3RvckpJVEdlbmVyYXRvci5fZ2VuT25DaGVjayIsIkNoYW5nZURldGVjdG9ySklUR2VuZXJhdG9yLl9nZW5PbkluaXQiLCJDaGFuZ2VEZXRlY3RvckpJVEdlbmVyYXRvci5fZ2VuT25DaGFuZ2UiLCJDaGFuZ2VEZXRlY3RvckpJVEdlbmVyYXRvci5fZ2VuTm90aWZ5T25QdXNoRGV0ZWN0b3JzIl0sIm1hcHBpbmdzIjoiT0FBTyxFQUFPLGlCQUFpQixFQUFFLE9BQU8sRUFB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LElBQUlBLFNBQVNBLEdBQUdBLENBQUNBLENBQUNBLElBQUlBLENBQUNBLEdBQUdBLENBQUNBLENBQUNBLEdBQUdBLEtBQUtBLElBQUlBLENBQUNBLE1BQU1BLENBQUNBLFlBQVlBLENBQUNBLEdBQUdBLENBQUNBLENBQUNBLENBQUNBLElBQUlBLENBQUNBLElBQUlBLENBQUNBLENBQUNBO1FBRTlFQSxJQUFJQSxRQUFRQSxHQUFHQSxJQUFJQSxDQUFDQSxNQUFNQSxDQUFDQSxZQUFZQSxDQUFDQSxDQUFDQSxDQUFDQSxTQUFTQSxDQUFDQSxDQUFDQTtRQUNyREEsSUFBSUEsUUFBUUEsR0FBR0EsSUFBSUEsQ0FBQ0EsTUFBTUEsQ0FBQ0EsWUFBWUEsQ0FBQ0EsQ0FBQ0EsQ0FBQ0EsU0FBU0EsQ0FBQ0EsQ0FBQ0E7UUFFckRBLElBQUlBLElBQUlBLEdBQUdBLElBQUlBLENBQUNBLE1BQU1BLENBQUNBLFdBQVdBLENBQUNBLENBQUNBLENBQUNBLFNBQVNBLENBQUNBLENBQUNBO1FBQ2hEQSxJQUFJQSxRQUFRQSxHQUFHQSxDQUFDQSxDQUFDQSxJQUFJQSxDQUFDQTtRQUV0QkEsSUFBSUEsSUFBSUEsR0FBR0E7WUFDSEEsSUFBSUEsUUFBUUEsSUFBSUEsQ0FBQ0EsMEJBQTBCQTtVQUM3Q0EsSUFBSUEsTUFBTUEsSUFBSUEsQ0FBQ0EsTUFBTUEsQ0FBQ0Esb0JBQW9CQSxFQUFFQSxTQUFTQSxRQUFRQTs7S0FFbEVBLENBQUNBO1FBQ0ZBLElBQUlBLElBQUlBLEdBQUdBLEdBQUdBLFFBQVFBLE1BQU1BLElBQUlBLG1CQUFtQkEsT0FBT0EsTUFBTUEsU0FBU0EsS0FBS0EsQ0FBQ0E7UUFFL0VBLElBQUlBLGdCQUFnQkEsR0FBR0EsQ0FBQ0EsQ0FBQ0EsSUFBSUEsQ0FBQ0EsR0FBR0EsQ0FBQ0EsQ0FBQ0EsQ0FBQ0EsS0FBS0EsSUFBSUEsQ0FBQ0EsTUFBTUEsQ0FBQ0EsYUFBYUEsQ0FBQ0EsQ0FBQ0EsQ0FBQ0EsQ0FBQ0EsQ0FBQ0E7UUFDdkVBLGdCQUFnQkEsQ0FBQ0EsSUFBSUEsQ0FBQ0EsSUFBSUEsQ0FB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QkFBZ0JBO0lBQ2hCQSx5QkFBeUJBLENBQUNBLENBQWNBO1FBQ3RDK0IsSUFBSUEsRUFBRUEsR0FBR0EsQ0FBQ0EsQ0FBQ0EsYUFBYUEsQ0FBQ0E7UUFDekJBLEVBQUVBLENBQUNBLENBQUNBLENBQUNBLENBQUNBLENBQUNBLGVBQWVBLElBQUlBLEVBQUVBLENBQUNBLHdCQUF3QkEsRUFBRUEsQ0FBQ0E7WUFBQ0EsTUFBTUEsQ0FBQ0EsRUFBRUEsQ0FBQ0E7UUFDbkVBLElBQUlBLE1BQU1BLEdBQUdBO1dBQ05BLGdCQUFnQkE7VUFDakJBLElBQUlBLENBQUNBLE1BQU1BLENBQUNBLGVBQWVBLENBQUNBLEVBQUVBLENBQUNBLGVBQWVBLENBQUNBLGNBQWNBLENBQUNBOztLQUVuRUEsQ0FBQ0E7UUFDRkEsTUFBTUEsQ0FBQ0EsTUFBTUEsQ0FBQ0E7SUFDaEJBLENBQUNBO0FBQ0gvQixDQUFDQTtBQUFBIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHtUeXBlLCBhc3NlcnRpb25zRW5hYmxlZCwgaXNCbGFuaywgaXNQcmVzZW50LCBTdHJpbmdXcmFwcGVyfSBmcm9tICdhbmd1bGFyMi9zcmMvZmFjYWRlL2xhbmcnO1xuaW1wb3J0IHtCYXNlRXhjZXB0aW9ufSBmcm9tICdhbmd1bGFyMi9zcmMvZmFjYWRlL2V4Y2VwdGlvbnMnO1xuaW1wb3J0IHtMaXN0V3JhcHBlciwgTWFwV3JhcHBlciwgU3RyaW5nTWFwV3JhcHBlcn0gZnJvbSAnYW5ndWxhcjIvc3JjL2ZhY2FkZS9jb2xsZWN0aW9uJztcblxuaW1wb3J0IHtBYnN0cmFjdENoYW5nZURldGVjdG9yfSBmcm9tICcuL2Fic3RyYWN0X2NoYW5nZV9kZXRlY3Rvcic7XG5pbXBvcnQge0NoYW5nZURldGVjdGlvblV0aWx9IGZyb20gJy4vY2hhbmdlX2RldGVjdGlvbl91dGlsJztcbmltcG9ydCB7RGlyZWN0aXZlSW5kZXgsIERpcmVjdGl2ZVJlY29yZH0gZnJvbSAnLi9kaXJlY3RpdmVfcmVjb3JkJztcblxuaW1wb3J0IHtQcm90b1JlY29yZCwgUmVjb3JkVHlwZX0gZnJvbSAnLi9wcm90b19yZWNvcmQnO1xuaW1wb3J0IHtDb2RlZ2VuTmFtZVV0aWwsIHNhbml0aXplTmFtZX0gZnJvbSAnLi9jb2RlZ2VuX25hbWVfdXRpbCc7XG5pbXBvcnQge0NvZGVnZW5Mb2dpY1V0aWx9IGZyb20gJy4vY29kZWdlbl9sb2dpY191dGlsJztcbmltcG9ydCB7Y29kaWZ5fSBmcm9tICcuL2NvZGVnZW5fZmFjYWRlJztcbmltcG9ydCB7RXZlbnRCaW5kaW5nfSBmcm9tICcuL2V2ZW50X2JpbmRpbmcnO1xuaW1wb3J0IHtCaW5kaW5nVGFyZ2V0fSBmcm9tICcuL2JpbmRpbmdfcmVjb3JkJztcbmltcG9ydCB7Q2hhbmdlRGV0ZWN0b3JHZW5Db25maWcsIENoYW5nZURldGVjdG9yRGVmaW5pdGlvbn0gZnJvbSAnLi9pbnRlcmZhY2VzJztcbmltcG9ydCB7Q2hhbmdlRGV0ZWN0aW9uU3RyYXRlZ3ksIENoYW5nZURldGVjdG9yU3RhdGV9IGZyb20gJy4vY29uc3RhbnRzJztcbmltcG9ydCB7Y3JlYXRlUHJvcGVydHlSZWNvcmRzLCBjcmVhdGVFdmVudFJlY29yZHN9IGZyb20gJy4vcHJvdG9fY2hhbmdlX2RldGVjdG9yJztcblxuLyoqXG4gKiBUaGUgY29kZSBnZW5lcmF0b3IgdGFrZXMgYSBsaXN0IG9mIHByb3RvIHJlY29yZHMgYW5kIGNyZWF0ZXMgYSBmdW5jdGlvbi9jbGFzc1xuICogdGhhdCBcImVtdWxhdGVzXCIgd2hhdCB0aGUgZGV2ZWxvcGVyIHdvdWxkIHdyaXRlIGJ5IGhhbmQgdG8gaW1wbGVtZW50IHRoZSBzYW1lXG4gKiBraW5kIG9mIGJlaGF2aW91ci5cbiAqXG4gKiBUaGlzIGNvZGUgc2hvdWxkIGJlIGtlcHQgaW4gc3luYyB3aXRoIHRoZSBEYXJ0IHRyYW5zZm9ybWVyJ3NcbiAqIGBhbmd1bGFyMi50cmFuc2Zvcm0udGVtcGxhdGVfY29tcGlsZXIuY2hhbmdlX2RldGVjdG9yX2NvZGVnZW5gIGxpYnJhcnkuIElmIHlvdSBtYWtlIHVwZGF0ZXNcbiAqIGhlcmUsIHBsZWFzZSBtYWtlIGVxdWl2YWxlbnQgY2hhbmdlcyB0aGVyZS5cbiovXG5jb25zdCBJU19DSEFOR0VEX0xPQ0FMID0gXCJpc0NoYW5nZWRcIjtcbmNvbnN0IENIQU5HRVNfTE9DQUwgPSBcImNoYW5nZXNcIjtcblxuZXhwb3J0IGNsYXNzIENoYW5nZURldGVjdG9ySklUR2VuZXJhdG9yIHtcbiAgcHJpdmF0ZSBfbG9naWM6IENvZGVnZW5Mb2dpY1V0aWw7XG4gIHByaXZhdGUgX25hbWVzOiBDb2RlZ2VuTmFtZVV0aWw7XG4gIHByaXZhdGUgX2VuZE9mQmxvY2tJZHhzOiBudW1iZXJbXTtcbiAgcHJpdmF0ZSBpZDogc3RyaW5nO1xuICBwcml2YXRlIGNoYW5nZURldGVjdGlvblN0cmF0ZWd5OiBDaGFuZ2VEZXRlY3Rpb25TdHJhdGVneTtcbiAgcHJpdmF0ZSByZWNvcmRzOiBQcm90b1JlY29yZFtdO1xuICBwcml2YXRlIHByb3BlcnR5QmluZGluZ1RhcmdldHM6IEJpbmRpbmdUYXJnZXRbXTtcbiAgcHJpdmF0ZSBldmVudEJpbmRpbmdzOiBFdmVudEJpbmRpbmdbXTtcbiAgcHJpdmF0ZSBkaXJlY3RpdmVSZWNvcmRzOiBhbnlbXTtcbiAgcHJpdmF0ZSBnZW5Db25maWc6IENoYW5nZURldGVjdG9yR2VuQ29uZmlnO1xuICB0eXBlTmFtZTogc3RyaW5nO1xuXG4gIGNvbnN0cnVjdG9yKGRlZmluaXRpb246IENoYW5nZURldGVjdG9yRGVmaW5pdGlvbiwgcHJpdmF0ZSBjaGFuZ2VEZXRlY3Rpb25VdGlsVmFyTmFtZTogc3RyaW5nLFxuICAgICAgICAgICAgICBwcml2YXRlIGFic3RyYWN0Q2hhbmdlRGV0ZWN0b3JWYXJOYW1lOiBzdHJpbmcsXG4gICAgICAgICAgICAgIHByaXZhdGUgY2hhbmdlRGV0ZWN0b3JTdGF0ZVZhck5hbWU6IHN0cmluZykge1xuICAgIHZhciBwcm9wZXJ0eUJpbmRpbmdSZWNvcmRzID0gY3JlYXRlUHJvcGVydHlSZWNvcmRzKGRlZmluaXRpb24pO1xuICAgIHZhciBldmVudEJpbmRpbmdSZWNvcmRzID0gY3JlYXRlRXZlbnRSZWNvcmRzKGRlZmluaXRpb24pO1xuICAgIHZhciBwcm9wZXJ0eUJpbmRpbmdUYXJnZXRzID0gZGVmaW5pdGlvbi5iaW5kaW5nUmVjb3Jkcy5tYXAoYiA9PiBiLnRhcmdldCk7XG4gICAgdGhpcy5pZCA9IGRlZmluaXRpb24uaWQ7XG4gICAgdGhpcy5jaGFuZ2VEZXRlY3Rpb25TdHJhdGVneSA9IGRlZmluaXRpb24uc3RyYXRlZ3k7XG4gICAgdGhpcy5nZW5Db25maWcgPSBkZWZpbml0aW9uLmdlbkNvbmZpZztcblxuICAgIHRoaXMucmVjb3JkcyA9IHByb3BlcnR5QmluZGluZ1JlY29yZHM7XG4gICAgdGhpcy5wcm9wZXJ0eUJpbmRpbmdUYXJnZXRzID0gcHJvcGVydHlCaW5kaW5nVGFyZ2V0cztcbiAgICB0aGlzLmV2ZW50QmluZGluZ3MgPSBldmVudEJpbmRpbmdSZWNvcmRzO1xuICAgIHRoaXMuZGlyZWN0aXZlUmVjb3JkcyA9IGRlZmluaXRpb24uZGlyZWN0aXZlUmVjb3JkcztcbiAgICB0aGlzLl9uYW1lcyA9IG5ldyBDb2RlZ2VuTmFtZVV0aWwodGhpcy5yZWNvcmRzLCB0aGlzLmV2ZW50QmluZGluZ3MsIHRoaXMuZGlyZWN0aXZlUmVjb3JkcyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5jaGFuZ2VEZXRlY3Rpb25VdGlsVmFyTmFtZSk7XG4gICAgdGhpcy5fbG9naWMgPSBuZXcgQ29kZWdlbkxvZ2ljVXRpbCh0aGlzLl9uYW1lcywgdGhpcy5jaGFuZ2VEZXRlY3Rpb25VdGlsVmFyTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuY2hhbmdlRGV0ZWN0b3JTdGF0ZVZhck5hbWUpO1xuICAgIHRoaXMudHlwZU5hbWUgPSBzYW5pdGl6ZU5hbWUoYENoYW5nZURldGVjdG9yXyR7dGhpcy5pZH1gKTtcbiAgfVxuXG4gIGdlbmVyYXRlKCk6IEZ1bmN0aW9uIHtcbiAgICB2YXIgZmFjdG9yeVNvdXJjZSA9IGBcbiAgICAgICR7dGhpcy5nZW5lcmF0ZVNvdXJjZSgpfVxuICAgICAgcmV0dXJuIGZ1bmN0aW9uKCkge1xuICAgICAgICByZXR1cm4gbmV3ICR7dGhpcy50eXBlTmFtZX0oKTtcbiAgICAgIH1cbiAgICBgO1xuICAgIHJldHVybiBuZXcgRnVuY3Rpb24odGhpcy5hYnN0cmFjdENoYW5nZURldGVjdG9yVmFyTmFtZSwgdGhpcy5jaGFuZ2VEZXRlY3Rpb25VdGlsVmFyTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuY2hhbmdlRGV0ZWN0b3JTdGF0ZVZhck5hbWUsIGZhY3RvcnlTb3VyY2UpKFxuICAgICAgICBBYnN0cmFjdENoYW5nZURldGVjdG9yLCBDaGFuZ2VEZXRlY3Rpb25VdGlsLCBDaGFuZ2VEZXRlY3RvclN0YXRlKTtcbiAgfVxuXG4gIGdlbmVyYXRlU291cmNlKCk6IHN0cmluZyB7XG4gICAgcmV0dXJuIGBcbiAgICAgIHZhciAke3RoaXMudHlwZU5hbWV9ID0gZnVuY3Rpb24gJHt0aGlzLnR5cGVOYW1lfSgpIHtcbiAgICAgICAgJHt0aGlzLmFic3RyYWN0Q2hhbmdlRGV0ZWN0b3JWYXJOYW1lfS5jYWxsKFxuICAgICAgICAgICAgdGhpcywgJHtKU09OLnN0cmluZ2lmeSh0aGlzLmlkKX0sICR7dGhpcy5yZWNvcmRzLmxlbmd0aH0sXG4gICAgICAgICAgICAke3RoaXMudHlwZU5hbWV9Lmdlbl9wcm9wZXJ0eUJpbmRpbmdUYXJnZXRzLCAke3RoaXMudHlwZU5hbWV9Lmdlbl9kaXJlY3RpdmVJbmRpY2VzLFxuICAgICAgICAgICAgJHtjb2RpZnkodGhpcy5jaGFuZ2VEZXRlY3Rpb25TdHJhdGVneSl9KTtcbiAgICAgICAgdGhpcy5kZWh5ZHJhdGVEaXJlY3RpdmVzKGZhbHNlKTtcbiAgICAgIH1cblxuICAgICAgJHt0aGlzLnR5cGVOYW1lfS5wcm90b3R5cGUgPSBPYmplY3QuY3JlYXRlKCR7dGhpcy5hYnN0cmFjdENoYW5nZURldGVjdG9yVmFyTmFtZX0ucHJvdG90eXBlKTtcblxuICAgICAgJHt0aGlzLnR5cGVOYW1lfS5wcm90b3R5cGUuZGV0ZWN0Q2hhbmdlc0luUmVjb3Jkc0ludGVybmFsID0gZnVuY3Rpb24odGhyb3dPbkNoYW5nZSkge1xuICAgICAgICAke3RoaXMuX25hbWVzLmdlbkluaXRMb2NhbHMoKX1cbiAgICAgICAgdmFyICR7SVNfQ0hBTkdFRF9MT0NBTH0gPSBmYWxzZTtcbiAgICAgICAgdmFyICR7Q0hBTkdFU19MT0NBTH0gPSBudWxsO1xuXG4gICAgICAgICR7dGhpcy5fZ2VuQWxsUmVjb3Jkcyh0aGlzLnJlY29yZHMpfVxuICAgICAgfVxuXG4gICAgICAke3RoaXMuX21heWJlR2VuSGFuZGxlRXZlbnRJbnRlcm5hbCgpfVxuXG4gICAgICAke3RoaXMuX21heWJlR2VuQWZ0ZXJDb250ZW50TGlmZWN5Y2xlQ2FsbGJhY2tzKCl9XG5cbiAgICAgICR7dGhpcy5fbWF5YmVHZW5BZnRlclZpZXdMaWZlY3ljbGVDYWxsYmFja3MoKX1cblxuICAgICAgJHt0aGlzLl9tYXliZUdlbkh5ZHJhdGVEaXJlY3RpdmVzKCl9XG5cbiAgICAgICR7dGhpcy5fbWF5YmVHZW5EZWh5ZHJhdGVEaXJlY3RpdmVzKCl9XG5cbiAgICAgICR7dGhpcy5fZ2VuUHJvcGVydHlCaW5kaW5nVGFyZ2V0cygpfVxuXG4gICAgICAke3RoaXMuX2dlbkRpcmVjdGl2ZUluZGljZXMoKX1cbiAgICBgO1xuICB9XG5cbiAgLyoqIEBpbnRlcm5hbCAqL1xuICBfZ2VuUHJvcGVydHlCaW5kaW5nVGFyZ2V0cygpOiBzdHJpbmcge1xuICAgIHZhciB0YXJnZXRzID0gdGhpcy5fbG9naWMuZ2VuUHJvcGVydHlCaW5kaW5nVGFyZ2V0cyh0aGlzLnByb3BlcnR5QmluZGluZ1RhcmdldHMsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuZ2VuQ29uZmlnLmdlbkRlYnVnSW5mbyk7XG4gICAgcmV0dXJuIGAke3RoaXMudHlwZU5hbWV9Lmdlbl9wcm9wZXJ0eUJpbmRpbmdUYXJnZXRzID0gJHt0YXJnZXRzfTtgO1xuICB9XG5cbiAgLyoqIEBpbnRlcm5hbCAqL1xuICBfZ2VuRGlyZWN0aXZlSW5kaWNlcygpOiBzdHJpbmcge1xuICAgIHZhciBpbmRpY2VzID0gdGhpcy5fbG9naWMuZ2VuRGlyZWN0aXZlSW5kaWNlcyh0aGlzLmRpcmVjdGl2ZVJlY29yZHMpO1xuICAgIHJldHVybiBgJHt0aGlzLnR5cGVOYW1lfS5nZW5fZGlyZWN0aXZlSW5kaWNlcyA9ICR7aW5kaWNlc307YDtcbiAgfVxuXG4gIC8qKiBAaW50ZXJuYWwgKi9cbiAgX21heWJlR2VuSGFuZGxlRXZlbnRJbnRlcm5hbCgpOiBzdHJpbmcge1xuICAgIGlmICh0aGlzLmV2ZW50QmluZGluZ3MubGVuZ3RoID4gMCkge1xuICAgICAgdmFyIGhhbmRsZXJzID0gdGhpcy5ldmVudEJpbmRpbmdzLm1hcChlYiA9PiB0aGlzLl9nZW5FdmVudEJpbmRpbmcoZWIpKS5qb2luKFwiXFxuXCIpO1xuICAgICAgcmV0dXJuIGBcbiAgICAgICAgJHt0aGlzLnR5cGVOYW1lfS5wcm90b3R5cGUuaGFuZGxlRXZlbnRJbnRlcm5hbCA9IGZ1bmN0aW9uKGV2ZW50TmFtZSwgZWxJbmRleCwgbG9jYWxzKSB7XG4gICAgICAgICAgdmFyICR7dGhpcy5fbmFtZXMuZ2V0UHJldmVudERlZmF1bHRBY2Nlc29yKCl9ID0gZmFsc2U7XG4gICAgICAgICAgJHt0aGlzLl9uYW1lcy5nZW5Jbml0RXZlbnRMb2NhbHMoKX1cbiAgICAgICAgICAke2hhbmRsZXJzfVxuICAgICAgICAgIHJldHVybiAke3RoaXMuX25hbWVzLmdldFByZXZlbnREZWZhdWx0QWNjZXNvcigpfTtcbiAgICAgICAgfVxuICAgICAgYDtcbiAgICB9IGVsc2Uge1xuICAgICAgcmV0dXJuICcnO1xuICAgIH1cbiAgfVxuXG4gIC8qKiBAaW50ZXJuYWwgKi9cbiAgX2dlbkV2ZW50QmluZGluZyhlYjogRXZlbnRCaW5kaW5nKTogc3RyaW5nIHtcbiAgICBsZXQgY29kZXM6IFN0cmluZ1tdID0gW107XG4gICAgdGhpcy5fZW5kT2ZCbG9ja0lkeHMgPSBbXTtcblxuICAgIExpc3RXcmFwcGVyLmZvckVhY2hXaXRoSW5kZXgoZWIucmVjb3JkcywgKHIsIGkpID0+IHtcbiAgICAgIGxldCBjb2RlO1xuXG4gICAgICBpZiAoci5pc0NvbmRpdGlvbmFsU2tpcFJlY29yZCgpKSB7XG4gICAgICAgIGNvZGUgPSB0aGlzLl9nZW5Db25kaXRpb25hbFNraXAociwgdGhpcy5fbmFtZXMuZ2V0RXZlbnRMb2NhbE5hbWUoZWIsIGkpKTtcbiAgICAgIH0gZWxzZSBpZiAoci5pc1VuY29uZGl0aW9uYWxTa2lwUmVjb3JkKCkpIHtcbiAgICAgICAgY29kZSA9IHRoaXMuX2dlblVuY29uZGl0aW9uYWxTa2lwKHIpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgY29kZSA9IHRoaXMuX2dlbkV2ZW50QmluZGluZ0V2YWwoZWIsIHIpO1xuICAgICAgfVxuXG4gICAgICBjb2RlICs9IHRoaXMuX2dlbkVuZE9mU2tpcEJsb2NrKGkpO1xuXG4gICAgICBjb2Rlcy5wdXNoKGNvZGUpO1xuICAgIH0pO1xuXG4gICAgcmV0dXJuIGBcbiAgICBpZiAoZXZlbnROYW1lID09PSBcIiR7ZWIuZXZlbnROYW1lfVwiICYmIGVsSW5kZXggPT09ICR7ZWIuZWxJbmRleH0pIHtcbiAgICAgICR7Y29kZXMuam9pbihcIlxcblwiKX1cbiAgICB9YDtcbiAgfVxuXG4gIC8qKiBAaW50ZXJuYWwgKi9cbiAgX2dlbkV2ZW50QmluZGluZ0V2YWwoZWI6IEV2ZW50QmluZGluZywgcjogUHJvdG9SZWNvcmQpOiBzdHJpbmcge1xuICAgIGlmIChyLmxhc3RJbkJpbmRpbmcpIHtcbiAgICAgIHZhciBldmFsUmVjb3JkID0gdGhpcy5fbG9naWMuZ2VuRXZlbnRCaW5kaW5nRXZhbFZhbHVlKGViLCByKTtcbiAgICAgIHZhciBtYXJrUGF0aCA9IHRoaXMuX2dlbk1hcmtQYXRoVG9Sb290QXNDaGVja09uY2Uocik7XG4gICAgICB2YXIgcHJldkRlZmF1bHQgPSB0aGlzLl9nZW5VcGRhdGVQcmV2ZW50RGVmYXVsdChlYiwgcik7XG4gICAgICByZXR1cm4gYCR7bWFya1BhdGh9XFxuJHtldmFsUmVjb3JkfVxcbiR7cHJldkRlZmF1bHR9YDtcbiAgICB9IGVsc2Uge1xuICAgICAgcmV0dXJuIHRoaXMuX2xvZ2ljLmdlbkV2ZW50QmluZGluZ0V2YWxWYWx1ZShlYiwgcik7XG4gICAgfVxuICB9XG5cbiAgLyoqIEBpbnRlcm5hbCAqL1xuICBfZ2VuTWFya1BhdGhUb1Jvb3RBc0NoZWNrT25jZShyOiBQcm90b1JlY29yZCk6IHN0cmluZyB7XG4gICAgdmFyIGJyID0gci5iaW5kaW5nUmVjb3JkO1xuICAgIGlmIChici5pc0RlZmF1bHRDaGFuZ2VEZXRlY3Rpb24oKSkge1xuICAgICAgcmV0dXJuIFwiXCI7XG4gICAgfSBlbHNlIHtcbiAgICAgIHJldHVybiBgJHt0aGlzLl9uYW1lcy5nZXREZXRlY3Rvck5hbWUoYnIuZGlyZWN0aXZlUmVjb3JkLmRpcmVjdGl2ZUluZGV4KX0ubWFya1BhdGhUb1Jvb3RBc0NoZWNrT25jZSgpO2A7XG4gICAgfVxuICB9XG5cbiAgLyoqIEBpbnRlcm5hbCAqL1xuICBfZ2VuVXBkYXRlUHJldmVudERlZmF1bHQoZWI6IEV2ZW50QmluZGluZywgcjogUHJvdG9SZWNvcmQpOiBzdHJpbmcge1xuICAgIHZhciBsb2NhbCA9IHRoaXMuX25hbWVzLmdldEV2ZW50TG9jYWxOYW1lKGViLCByLnNlbGZJbmRleCk7XG4gICAgcmV0dXJuIGBpZiAoJHtsb2NhbH0gPT09IGZhbHNlKSB7ICR7dGhpcy5fbmFtZXMuZ2V0UHJldmVudERlZmF1bHRBY2Nlc29yKCl9ID0gdHJ1ZX07YDtcbiAgfVxuXG4gIC8qKiBAaW50ZXJuYWwgKi9cbiAgX21heWJlR2VuRGVoeWRyYXRlRGlyZWN0aXZlcygpOiBzdHJpbmcge1xuICAgIHZhciBkZXN0cm95UGlwZXNDb2RlID0gdGhpcy5fbmFtZXMuZ2VuUGlwZU9uRGVzdHJveSgpO1xuICAgIHZhciBkZXN0cm95RGlyZWN0aXZlc0NvZGUgPSB0aGlzLl9sb2dpYy5nZW5EaXJlY3RpdmVzT25EZXN0cm95KHRoaXMuZGlyZWN0aXZlUmVjb3Jkcyk7XG4gICAgdmFyIGRlaHlkcmF0ZUZpZWxkc0NvZGUgPSB0aGlzLl9uYW1lcy5nZW5EZWh5ZHJhdGVGaWVsZHMoKTtcbiAgICBpZiAoIWRlc3Ryb3lQaXBlc0NvZGUgJiYgIWRlc3Ryb3lEaXJlY3RpdmVzQ29kZSAmJiAhZGVoeWRyYXRlRmllbGRzQ29kZSkgcmV0dXJuICcnO1xuICAgIHJldHVybiBgJHt0aGlzLnR5cGVOYW1lfS5wcm90b3R5cGUuZGVoeWRyYXRlRGlyZWN0aXZlcyA9IGZ1bmN0aW9uKGRlc3Ryb3lQaXBlcykge1xuICAgICAgICBpZiAoZGVzdHJveVBpcGVzKSB7XG4gICAgICAgICAgJHtkZXN0cm95UGlwZXNDb2RlfVxuICAgICAgICAgICR7ZGVzdHJveURpcmVjdGl2ZXNDb2RlfVxuICAgICAgICB9XG4gICAgICAgICR7ZGVoeWRyYXRlRmllbGRzQ29kZX1cbiAgICB9YDtcbiAgfVxuXG4gIC8qKiBAaW50ZXJuYWwgKi9cbiAgX21heWJlR2VuSHlkcmF0ZURpcmVjdGl2ZXMoKTogc3RyaW5nIHtcbiAgICB2YXIgaHlkcmF0ZURpcmVjdGl2ZXNDb2RlID0gdGhpcy5fbG9naWMuZ2VuSHlkcmF0ZURpcmVjdGl2ZXModGhpcy5kaXJlY3RpdmVSZWNvcmRzKTtcbiAgICB2YXIgaHlkcmF0ZURldGVjdG9yc0NvZGUgPSB0aGlzLl9sb2dpYy5nZW5IeWRyYXRlRGV0ZWN0b3JzKHRoaXMuZGlyZWN0aXZlUmVjb3Jkcyk7XG4gICAgaWYgKCFoeWRyYXRlRGlyZWN0aXZlc0NvZGUgJiYgIWh5ZHJhdGVEZXRlY3RvcnNDb2RlKSByZXR1cm4gJyc7XG4gICAgcmV0dXJuIGAke3RoaXMudHlwZU5hbWV9LnByb3RvdHlwZS5oeWRyYXRlRGlyZWN0aXZlcyA9IGZ1bmN0aW9uKGRpcmVjdGl2ZXMpIHtcbiAgICAgICR7aHlkcmF0ZURpcmVjdGl2ZXNDb2RlfVxuICAgICAgJHtoeWRyYXRlRGV0ZWN0b3JzQ29kZX1cbiAgICB9YDtcbiAgfVxuXG4gIC8qKiBAaW50ZXJuYWwgKi9cbiAgX21heWJlR2VuQWZ0ZXJDb250ZW50TGlmZWN5Y2xlQ2FsbGJhY2tzKCk6IHN0cmluZyB7XG4gICAgdmFyIG5vdGlmaWNhdGlvbnMgPSB0aGlzLl9sb2dpYy5nZW5Db250ZW50TGlmZWN5Y2xlQ2FsbGJhY2tzKHRoaXMuZGlyZWN0aXZlUmVjb3Jkcyk7XG4gICAgaWYgKG5vdGlmaWNhdGlvbnMubGVuZ3RoID4gMCkge1xuICAgICAgdmFyIGRpcmVjdGl2ZU5vdGlmaWNhdGlvbnMgPSBub3RpZmljYXRpb25zLmpvaW4oXCJcXG5cIik7XG4gICAgICByZXR1cm4gYFxuICAgICAgICAke3RoaXMudHlwZU5hbWV9LnByb3RvdHlwZS5hZnRlckNvbnRlbnRMaWZlY3ljbGVDYWxsYmFja3NJbnRlcm5hbCA9IGZ1bmN0aW9uKCkge1xuICAgICAgICAgICR7ZGlyZWN0aXZlTm90aWZpY2F0aW9uc31cbiAgICAgICAgfVxuICAgICAgYDtcbiAgICB9IGVsc2Uge1xuICAgICAgcmV0dXJuICcnO1xuICAgIH1cbiAgfVxuXG4gIC8qKiBAaW50ZXJuYWwgKi9cbiAgX21heWJlR2VuQWZ0ZXJWaWV3TGlmZWN5Y2xlQ2FsbGJhY2tzKCk6IHN0cmluZyB7XG4gICAgdmFyIG5vdGlmaWNhdGlvbnMgPSB0aGlzLl9sb2dpYy5nZW5WaWV3TGlmZWN5Y2xlQ2FsbGJhY2tzKHRoaXMuZGlyZWN0aXZlUmVjb3Jkcyk7XG4gICAgaWYgKG5vdGlmaWNhdGlvbnMubGVuZ3RoID4gMCkge1xuICAgICAgdmFyIGRpcmVjdGl2ZU5vdGlmaWNhdGlvbnMgPSBub3RpZmljYXRpb25zLmpvaW4oXCJcXG5cIik7XG4gICAgICByZXR1cm4gYFxuICAgICAgICAke3RoaXMudHlwZU5hbWV9LnByb3RvdHlwZS5hZnRlclZpZXdMaWZlY3ljbGVDYWxsYmFja3NJbnRlcm5hbCA9IGZ1bmN0aW9uKCkge1xuICAgICAgICAgICR7ZGlyZWN0aXZlTm90aWZpY2F0aW9uc31cbiAgICAgICAgfVxuICAgICAgYDtcbiAgICB9IGVsc2Uge1xuICAgICAgcmV0dXJuICcnO1xuICAgIH1cbiAgfVxuXG4gIC8qKiBAaW50ZXJuYWwgKi9cbiAgX2dlbkFsbFJlY29yZHMocnM6IFByb3RvUmVjb3JkW10pOiBzdHJpbmcge1xuICAgIHZhciBjb2RlczogU3RyaW5nW10gPSBbXTtcbiAgICB0aGlzLl9lbmRPZkJsb2NrSWR4cyA9IFtdO1xuXG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBycy5sZW5ndGg7IGkrKykge1xuICAgICAgbGV0IGNvZGU7XG4gICAgICBsZXQgciA9IHJzW2ldO1xuXG4gICAgICBpZiAoci5pc0xpZmVDeWNsZVJlY29yZCgpKSB7XG4gICAgICAgIGNvZGUgPSB0aGlzLl9nZW5EaXJlY3RpdmVMaWZlY3ljbGUocik7XG4gICAgICB9IGVsc2UgaWYgKHIuaXNQaXBlUmVjb3JkKCkpIHtcbiAgICAgICAgY29kZSA9IHRoaXMuX2dlblBpcGVDaGVjayhyKTtcbiAgICAgIH0gZWxzZSBpZiAoci5pc0NvbmRpdGlvbmFsU2tpcFJlY29yZCgpKSB7XG4gICAgICAgIGNvZGUgPSB0aGlzLl9nZW5Db25kaXRpb25hbFNraXAociwgdGhpcy5fbmFtZXMuZ2V0TG9jYWxOYW1lKHIuY29udGV4dEluZGV4KSk7XG4gICAgICB9IGVsc2UgaWYgKHIuaXNVbmNvbmRpdGlvbmFsU2tpcFJlY29yZCgpKSB7XG4gICAgICAgIGNvZGUgPSB0aGlzLl9nZW5VbmNvbmRpdGlvbmFsU2tpcChyKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGNvZGUgPSB0aGlzLl9nZW5SZWZlcmVuY2VDaGVjayhyKTtcbiAgICAgIH1cblxuICAgICAgY29kZSA9IGBcbiAgICAgICAgJHt0aGlzLl9tYXliZUZpcnN0SW5CaW5kaW5nKHIpfVxuICAgICAgICAke2NvZGV9XG4gICAgICAgICR7dGhpcy5fbWF5YmVHZW5MYXN0SW5EaXJlY3RpdmUocil9XG4gICAgICAgICR7dGhpcy5fZ2VuRW5kT2ZTa2lwQmxvY2soaSl9XG4gICAgICBgO1xuXG4gICAgICBjb2Rlcy5wdXNoKGNvZGUpO1xuICAgIH1cblxuICAgIHJldHVybiBjb2Rlcy5qb2luKFwiXFxuXCIpO1xuICB9XG5cbiAgLyoqIEBpbnRlcm5hbCAqL1xuICBfZ2VuQ29uZGl0aW9uYWxTa2lwKHI6IFByb3RvUmVjb3JkLCBjb25kaXRpb246IHN0cmluZyk6IHN0cmluZyB7XG4gICAgbGV0IG1heWJlTmVnYXRlID0gci5tb2RlID09PSBSZWNvcmRUeXBlLlNraXBSZWNvcmRzSWYgPyAnIScgOiAnJztcbiAgICB0aGlzLl9lbmRPZkJsb2NrSWR4cy5wdXNoKHIuZml4ZWRBcmdzWzBdIC0gMSk7XG5cbiAgICByZXR1cm4gYGlmICgke21heWJlTmVnYXRlfSR7Y29uZGl0aW9ufSkge2A7XG4gIH1cblxuICAvKiogQGludGVybmFsICovXG4gIF9nZW5VbmNvbmRpdGlvbmFsU2tpcChyOiBQcm90b1JlY29yZCk6IHN0cmluZyB7XG4gICAgdGhpcy5fZW5kT2ZCbG9ja0lkeHMucG9wKCk7XG4gICAgdGhpcy5fZW5kT2ZCbG9ja0lkeHMucHVzaChyLmZpeGVkQXJnc1swXSAtIDEpO1xuICAgIHJldHVybiBgfSBlbHNlIHtgO1xuICB9XG5cbiAgLyoqIEBpbnRlcm5hbCAqL1xuICBfZ2VuRW5kT2ZTa2lwQmxvY2socHJvdG9JbmRleDogbnVtYmVyKTogc3RyaW5nIHtcbiAgICBpZiAoIUxpc3RXcmFwcGVyLmlzRW1wdHkodGhpcy5fZW5kT2ZCbG9ja0lkeHMpKSB7XG4gICAgICBsZXQgZW5kT2ZCbG9jayA9IExpc3RXcmFwcGVyLmxhc3QodGhpcy5fZW5kT2ZCbG9ja0lkeHMpO1xuICAgICAgaWYgKHByb3RvSW5kZXggPT09IGVuZE9mQmxvY2spIHtcbiAgICAgICAgdGhpcy5fZW5kT2ZCbG9ja0lkeHMucG9wKCk7XG4gICAgICAgIHJldHVybiAnfSc7XG4gICAgICB9XG4gICAgfVxuXG4gICAgcmV0dXJuICcnO1xuICB9XG5cbiAgLyoqIEBpbnRlcm5hbCAqL1xuICBfZ2VuRGlyZWN0aXZlTGlmZWN5Y2xlKHI6IFByb3RvUmVjb3JkKTogc3RyaW5nIHtcbiAgICBpZiAoci5uYW1lID09PSBcIkRvQ2hlY2tcIikge1xuICAgICAgcmV0dXJuIHRoaXMuX2dlbk9uQ2hlY2socik7XG4gICAgfSBlbHNlIGlmIChyLm5hbWUgPT09IFwiT25Jbml0XCIpIHtcbiAgICAgIHJldHVybiB0aGlzLl9nZW5PbkluaXQocik7XG4gICAgfSBlbHNlIGlmIChyLm5hbWUgPT09IFwiT25DaGFuZ2VzXCIpIHtcbiAgICAgIHJldHVybiB0aGlzLl9nZW5PbkNoYW5nZShyKTtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhyb3cgbmV3IEJhc2VFeGNlcHRpb24oYFVua25vd24gbGlmZWN5Y2xlIGV2ZW50ICcke3IubmFtZX0nYCk7XG4gICAgfVxuICB9XG5cbiAgLyoqIEBpbnRlcm5hbCAqL1xuICBfZ2VuUGlwZUNoZWNrKHI6IFByb3RvUmVjb3JkKTogc3RyaW5nIHtcbiAgICB2YXIgY29udGV4dCA9IHRoaXMuX25hbWVzLmdldExvY2FsTmFtZShyLmNvbnRleHRJbmRleCk7XG4gICAgdmFyIGFyZ1N0cmluZyA9IHIuYXJncy5tYXAoKGFyZykgPT4gdGhpcy5fbmFtZXMuZ2V0TG9jYWxOYW1lKGFyZykpLmpvaW4oXCIsIFwiKTtcblxuICAgIHZhciBvbGRWYWx1ZSA9IHRoaXMuX25hbWVzLmdldEZpZWxkTmFtZShyLnNlbGZJbmRleCk7XG4gICAgdmFyIG5ld1ZhbHVlID0gdGhpcy5fbmFtZXMuZ2V0TG9jYWxOYW1lKHIuc2VsZkluZGV4KTtcblxuICAgIHZhciBwaXBlID0gdGhpcy5fbmFtZXMuZ2V0UGlwZU5hbWUoci5zZWxmSW5kZXgpO1xuICAgIHZhciBwaXBlTmFtZSA9IHIubmFtZTtcblxuICAgIHZhciBpbml0ID0gYFxuICAgICAgaWYgKCR7cGlwZX0gPT09ICR7dGhpcy5jaGFuZ2VEZXRlY3Rpb25VdGlsVmFyTmFtZX0udW5pbml0aWFsaXplZCkge1xuICAgICAgICAke3BpcGV9ID0gJHt0aGlzLl9uYW1lcy5nZXRQaXBlc0FjY2Vzc29yTmFtZSgpfS5nZXQoJyR7cGlwZU5hbWV9Jyk7XG4gICAgICB9XG4gICAgYDtcbiAgICB2YXIgcmVhZCA9IGAke25ld1ZhbHVlfSA9ICR7cGlwZX0ucGlwZS50cmFuc2Zvcm0oJHtjb250ZXh0fSwgWyR7YXJnU3RyaW5nfV0pO2A7XG5cbiAgICB2YXIgY29udGV4T3JBcmdDaGVjayA9IHIuYXJncy5tYXAoKGEpID0+IHRoaXMuX25hbWVzLmdldENoYW5nZU5hbWUoYSkpO1xuICAgIGNvbnRleE9yQXJnQ2hlY2sucHVzaCh0aGlzLl9uYW1lcy5nZXRDaGFuZ2VOYW1lKHIuY29udGV4dEluZGV4KSk7XG4gICAgdmFyIGNvbmRpdGlvbiA9IGAhJHtwaXBlfS5wdXJlIHx8ICgke2NvbnRleE9yQXJnQ2hlY2suam9pbihcIiB8fCBcIil9KWA7XG5cbiAgICB2YXIgY2hlY2sgPSBgXG4gICAgICAke3RoaXMuX2dlblRocm93T25DaGFuZ2VDaGVjayhvbGRWYWx1ZSwgbmV3VmFsdWUpfVxuICAgICAgaWYgKCR7dGhpcy5jaGFuZ2VEZXRlY3Rpb25VdGlsVmFyTmFtZX0ubG9vc2VOb3RJZGVudGljYWwoJHtvbGRWYWx1ZX0sICR7bmV3VmFsdWV9KSkge1xuICAgICAgICAke25ld1ZhbHVlfSA9ICR7dGhpcy5jaGFuZ2VEZXRlY3Rpb25VdGlsVmFyTmFtZX0udW53cmFwVmFsdWUoJHtuZXdWYWx1ZX0pXG4gICAgICAgICR7dGhpcy5fZ2VuQ2hhbmdlTWFya2VyKHIpfVxuICAgICAgICAke3RoaXMuX2dlblVwZGF0ZURpcmVjdGl2ZU9yRWxlbWVudChyKX1cbiAgICAgICAgJHt0aGlzLl9nZW5BZGRUb0NoYW5nZXMocil9XG4gICAgICAgICR7b2xkVmFsdWV9ID0gJHtuZXdWYWx1ZX07XG4gICAgICB9XG4gICAgYDtcblxuICAgIHZhciBnZW5Db2RlID0gci5zaG91bGRCZUNoZWNrZWQoKSA/IGAke3JlYWR9JHtjaGVja31gIDogcmVhZDtcblxuICAgIGlmIChyLmlzVXNlZEJ5T3RoZXJSZWNvcmQoKSkge1xuICAgICAgcmV0dXJuIGAke2luaXR9IGlmICgke2NvbmRpdGlvbn0pIHsgJHtnZW5Db2RlfSB9IGVsc2UgeyAke25ld1ZhbHVlfSA9ICR7b2xkVmFsdWV9OyB9YDtcbiAgICB9IGVsc2Uge1xuICAgICAgcmV0dXJuIGAke2luaXR9IGlmICgke2NvbmRpdGlvbn0pIHsgJHtnZW5Db2RlfSB9YDtcbiAgICB9XG4gIH1cblxuICAvKiogQGludGVybmFsICovXG4gIF9nZW5SZWZlcmVuY2VDaGVjayhyOiBQcm90b1JlY29yZCk6IHN0cmluZyB7XG4gICAgdmFyIG9sZFZhbHVlID0gdGhpcy5fbmFtZXMuZ2V0RmllbGROYW1lKHIuc2VsZkluZGV4KTtcbiAgICB2YXIgbmV3VmFsdWUgPSB0aGlzLl9uYW1lcy5nZXRMb2NhbE5hbWUoci5zZWxmSW5kZXgpO1xuICAgIHZhciByZWFkID0gYFxuICAgICAgJHt0aGlzLl9sb2dpYy5nZW5Qcm9wZXJ0eUJpbmRpbmdFdmFsVmFsdWUocil9XG4gICAgYDtcblxuICAgIHZhciBjaGVjayA9IGBcbiAgICAgICR7dGhpcy5fZ2VuVGhyb3dPbkNoYW5nZUNoZWNrKG9sZFZhbHVlLCBuZXdWYWx1ZSl9XG4gICAgICBpZiAoJHt0aGlzLmNoYW5nZURldGVjdGlvblV0aWxWYXJOYW1lfS5sb29zZU5vdElkZW50aWNhbCgke29sZFZhbHVlfSwgJHtuZXdWYWx1ZX0pKSB7XG4gICAgICAgICR7dGhpcy5fZ2VuQ2hhbmdlTWFya2VyKHIpfVxuICAgICAgICAke3RoaXMuX2dlblVwZGF0ZURpcmVjdGl2ZU9yRWxlbWVudChyKX1cbiAgICAgICAgJHt0aGlzLl9nZW5BZGRUb0NoYW5nZXMocil9XG4gICAgICAgICR7b2xkVmFsdWV9ID0gJHtuZXdWYWx1ZX07XG4gICAgICB9XG4gICAgYDtcblxuICAgIHZhciBnZW5Db2RlID0gci5zaG91bGRCZUNoZWNrZWQoKSA/IGAke3JlYWR9JHtjaGVja31gIDogcmVhZDtcblxuICAgIGlmIChyLmlzUHVyZUZ1bmN0aW9uKCkpIHtcbiAgICAgIHZhciBjb25kaXRpb24gPSByLmFyZ3MubWFwKChhKSA9PiB0aGlzLl9uYW1lcy5nZXRDaGFuZ2VOYW1lKGEpKS5qb2luKFwiIHx8IFwiKTtcbiAgICAgIGlmIChyLmlzVXNlZEJ5T3RoZXJSZWNvcmQoKSkge1xuICAgICAgICByZXR1cm4gYGlmICgke2NvbmRpdGlvbn0pIHsgJHtnZW5Db2RlfSB9IGVsc2UgeyAke25ld1ZhbHVlfSA9ICR7b2xkVmFsdWV9OyB9YDtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHJldHVybiBgaWYgKCR7Y29uZGl0aW9ufSkgeyAke2dlbkNvZGV9IH1gO1xuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICByZXR1cm4gZ2VuQ29kZTtcbiAgICB9XG4gIH1cblxuICAvKiogQGludGVybmFsICovXG4gIF9nZW5DaGFuZ2VNYXJrZXIocjogUHJvdG9SZWNvcmQpOiBzdHJpbmcge1xuICAgIHJldHVybiByLmFyZ3VtZW50VG9QdXJlRnVuY3Rpb24gPyBgJHt0aGlzLl9uYW1lcy5nZXRDaGFuZ2VOYW1lKHIuc2VsZkluZGV4KX0gPSB0cnVlYCA6IGBgO1xuICB9XG5cbiAgLyoqIEBpbnRlcm5hbCAqL1xuICBfZ2VuVXBkYXRlRGlyZWN0aXZlT3JFbGVtZW50KHI6IFByb3RvUmVjb3JkKTogc3RyaW5nIHtcbiAgICBpZiAoIXIubGFzdEluQmluZGluZykgcmV0dXJuIFwiXCI7XG5cbiAgICB2YXIgbmV3VmFsdWUgPSB0aGlzLl9uYW1lcy5nZXRMb2NhbE5hbWUoci5zZWxmSW5kZXgpO1xuICAgIHZhciBub3RpZnlEZWJ1ZyA9IHRoaXMuZ2VuQ29uZmlnLmxvZ0JpbmRpbmdVcGRhdGUgPyBgdGhpcy5sb2dCaW5kaW5nVXBkYXRlKCR7bmV3VmFsdWV9KTtgIDogXCJcIjtcblxuICAgIHZhciBiciA9IHIuYmluZGluZ1JlY29yZDtcbiAgICBpZiAoYnIudGFyZ2V0LmlzRGlyZWN0aXZlKCkpIHtcbiAgICAgIHZhciBkaXJlY3RpdmVQcm9wZXJ0eSA9XG4gICAgICAgICAgYCR7dGhpcy5fbmFtZXMuZ2V0RGlyZWN0aXZlTmFtZShici5kaXJlY3RpdmVSZWNvcmQuZGlyZWN0aXZlSW5kZXgpfS4ke2JyLnRhcmdldC5uYW1lfWA7XG4gICAgICByZXR1cm4gYFxuICAgICAgICAke2RpcmVjdGl2ZVByb3BlcnR5fSA9ICR7bmV3VmFsdWV9O1xuICAgICAgICAke25vdGlmeURlYnVnfVxuICAgICAgICAke0lTX0NIQU5HRURfTE9DQUx9ID0gdHJ1ZTtcbiAgICAgIGA7XG4gICAgfSBlbHNlIHtcbiAgICAgIHJldHVybiBgXG4gICAgICAgIHRoaXMubm90aWZ5RGlzcGF0Y2hlcigke25ld1ZhbHVlfSk7XG4gICAgICAgICR7bm90aWZ5RGVidWd9XG4gICAgICBgO1xuICAgIH1cbiAgfVxuXG4gIC8qKiBAaW50ZXJuYWwgKi9cbiAgX2dlblRocm93T25DaGFuZ2VDaGVjayhvbGRWYWx1ZTogc3RyaW5nLCBuZXdWYWx1ZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgICBpZiAoYXNzZXJ0aW9uc0VuYWJsZWQoKSkge1xuICAgICAgcmV0dXJuIGBcbiAgICAgICAgaWYgKHRocm93T25DaGFuZ2UgJiYgISR7dGhpcy5jaGFuZ2VEZXRlY3Rpb25VdGlsVmFyTmFtZX0uZGV2TW9kZUVxdWFsKCR7b2xkVmFsdWV9LCAke25ld1ZhbHVlfSkpIHtcbiAgICAgICAgICB0aGlzLnRocm93T25DaGFuZ2VFcnJvcigke29sZFZhbHVlfSwgJHtuZXdWYWx1ZX0pO1xuICAgICAgICB9XG4gICAgICAgIGA7XG4gICAgfSBlbHNlIHtcbiAgICAgIHJldHVybiAnJztcbiAgICB9XG4gIH1cblxuICAvKiogQGludGVybmFsICovXG4gIF9nZW5BZGRUb0NoYW5nZXMocjogUHJvdG9SZWNvcmQpOiBzdHJpbmcge1xuICAgIHZhciBuZXdWYWx1ZSA9IHRoaXMuX25hbWVzLmdldExvY2FsTmFtZShyLnNlbGZJbmRleCk7XG4gICAgdmFyIG9sZFZhbHVlID0gdGhpcy5fbmFtZXMuZ2V0RmllbGROYW1lKHIuc2VsZkluZGV4KTtcbiAgICBpZiAoIXIuYmluZGluZ1JlY29yZC5jYWxsT25DaGFuZ2VzKCkpIHJldHVybiBcIlwiO1xuICAgIHJldHVybiBgJHtDSEFOR0VTX0xPQ0FMfSA9IHRoaXMuYWRkQ2hhbmdlKCR7Q0hBTkdFU19MT0NBTH0sICR7b2xkVmFsdWV9LCAke25ld1ZhbHVlfSk7YDtcbiAgfVxuXG4gIC8qKiBAaW50ZXJuYWwgKi9cbiAgX21heWJlRmlyc3RJbkJpbmRpbmcocjogUHJvdG9SZWNvcmQpOiBzdHJpbmcge1xuICAgIHZhciBwcmV2ID0gQ2hhbmdlRGV0ZWN0aW9uVXRpbC5wcm90b0J5SW5kZXgodGhpcy5yZWNvcmRzLCByLnNlbGZJbmRleCAtIDEpO1xuICAgIHZhciBmaXJzdEluQmluZGluZyA9IGlzQmxhbmsocHJldikgfHwgcHJldi5iaW5kaW5nUmVjb3JkICE9PSByLmJpbmRpbmdSZWNvcmQ7XG4gICAgcmV0dXJuIGZpcnN0SW5CaW5kaW5nICYmICFyLmJpbmRpbmdSZWNvcmQuaXNEaXJlY3RpdmVMaWZlY3ljbGUoKSA/XG4gICAgICAgICAgICAgICBgJHt0aGlzLl9uYW1lcy5nZXRQcm9wZXJ0eUJpbmRpbmdJbmRleCgpfSA9ICR7ci5wcm9wZXJ0eUJpbmRpbmdJbmRleH07YCA6XG4gICAgICAgICAgICAgICAnJztcbiAgfVxuXG4gIC8qKiBAaW50ZXJuYWwgKi9cbiAgX21heWJlR2VuTGFzdEluRGlyZWN0aXZlKHI6IFByb3RvUmVjb3JkKTogc3RyaW5nIHtcbiAgICBpZiAoIXIubGFzdEluRGlyZWN0aXZlKSByZXR1cm4gXCJcIjtcbiAgICByZXR1cm4gYFxuICAgICAgJHtDSEFOR0VTX0xPQ0FMfSA9IG51bGw7XG4gICAgICAke3RoaXMuX2dlbk5vdGlmeU9uUHVzaERldGVjdG9ycyhyKX1cbiAgICAgICR7SVNfQ0hBTkdFRF9MT0NBTH0gPSBmYWxzZTtcbiAgICBgO1xuICB9XG5cbiAgLyoqIEBpbnRlcm5hbCAqL1xuICBfZ2VuT25DaGVjayhyOiBQcm90b1JlY29yZCk6IHN0cmluZyB7XG4gICAgdmFyIGJyID0gci5iaW5kaW5nUmVjb3JkO1xuICAgIHJldHVybiBgaWYgKCF0aHJvd09uQ2hhbmdlKSAke3RoaXMuX25hbWVzLmdldERpcmVjdGl2ZU5hbWUoYnIuZGlyZWN0aXZlUmVjb3JkLmRpcmVjdGl2ZUluZGV4KX0ubmdEb0NoZWNrKCk7YDtcbiAgfVxuXG4gIC8qKiBAaW50ZXJuYWwgKi9cbiAgX2dlbk9uSW5pdChyOiBQcm90b1JlY29yZCk6IHN0cmluZyB7XG4gICAgdmFyIGJyID0gci5iaW5kaW5nUmVjb3JkO1xuICAgIHJldHVybiBgaWYgKCF0aHJvd09uQ2hhbmdlICYmICR7dGhpcy5fbmFtZXMuZ2V0U3RhdGVOYW1lKCl9ID09PSAke3RoaXMuY2hhbmdlRGV0ZWN0b3JTdGF0ZVZhck5hbWV9Lk5ldmVyQ2hlY2tlZCkgJHt0aGlzLl9uYW1lcy5nZXREaXJlY3RpdmVOYW1lKGJyLmRpcmVjdGl2ZVJlY29yZC5kaXJlY3RpdmVJbmRleCl9Lm5nT25Jbml0KCk7YDtcbiAgfVxuXG4gIC8qKiBAaW50ZXJuYWwgKi9cbiAgX2dlbk9uQ2hhbmdlKHI6IFByb3RvUmVjb3JkKTogc3RyaW5nIHtcbiAgICB2YXIgYnIgPSByLmJpbmRpbmdSZWNvcmQ7XG4gICAgcmV0dXJuIGBpZiAoIXRocm93T25DaGFuZ2UgJiYgJHtDSEFOR0VTX0xPQ0FMfSkgJHt0aGlzLl9uYW1lcy5nZXREaXJlY3RpdmVOYW1lKGJyLmRpcmVjdGl2ZVJlY29yZC5kaXJlY3RpdmVJbmRleCl9Lm5nT25DaGFuZ2VzKCR7Q0hBTkdFU19MT0NBTH0pO2A7XG4gIH1cblxuICAvKiogQGludGVybmFsICovXG4gIF9nZW5Ob3RpZnlPblB1c2hEZXRlY3RvcnMocjogUHJvdG9SZWNvcmQpOiBzdHJpbmcge1xuICAgIHZhciBiciA9IHIuYmluZGluZ1JlY29yZDtcbiAgICBpZiAoIXIubGFzdEluRGlyZWN0aXZlIHx8IGJyLmlzRGVmYXVsdENoYW5nZURldGVjdGlvbigpKSByZXR1cm4gXCJcIjtcbiAgICB2YXIgcmV0VmFsID0gYFxuICAgICAgaWYoJHtJU19DSEFOR0VEX0xPQ0FMfSkge1xuICAgICAgICAke3RoaXMuX25hbWVzLmdldERldGVjdG9yTmFtZShici5kaXJlY3RpdmVSZWNvcmQuZGlyZWN0aXZlSW5kZXgpfS5tYXJrQXNDaGVja09uY2UoKTtcbiAgICAgIH1cbiAgICBgO1xuICAgIHJldHVybiByZXRWYWw7XG4gIH1cbn1cbiJdfQ==