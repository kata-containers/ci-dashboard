def all_tests: .sections[].tests[];

def failing_tests: .failing_tests[];

def flaky_tests: .flaky_tests[];

def matching($pattern): select(.name | test($pattern; "i"));
             
def is_experimental: test("experimental"; "i");
def is_stable: is_experimental | not;

def experimental: select(.name | is_experimental);                     
def stable: select(.name | is_stable);

def passing: select(.status == "passed");

def skipped: select(.status == "not_run");
