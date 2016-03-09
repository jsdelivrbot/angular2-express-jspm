
import {Component} from 'angular2/core';
export * from './todo/todo';

// import 'twbs/bootstrap/css/bootstrap.css!';

@Component({
  selector: 'app',
  template: `
  <p>Hello World</p>
  `
})
export class AppComponent {
  constructor() { }

}
